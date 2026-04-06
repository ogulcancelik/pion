import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTilde } from "./paths.js";

export type RepoUpdateStatusKind =
	| "disabled"
	| "up-to-date"
	| "behind"
	| "ahead"
	| "diverged"
	| "no-upstream"
	| "detached"
	| "not-repo"
	| "fetch-failed";

export interface RepoUpdateStatus {
	kind: RepoUpdateStatusKind;
	repoPath: string;
	checkedAt: string;
	branch?: string;
	upstream?: string;
	localHead?: string;
	upstreamHead?: string;
	aheadCount?: number;
	behindCount?: number;
	dirty?: boolean;
	error?: string;
	stateKey?: string;
}

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitCommandResult>;

interface RepoUpdateCheckerState {
	lastAutomaticDay?: string;
	lastInjectedStateKey?: string;
	lastStatus?: RepoUpdateStatus;
}

export interface RepoUpdateCheckerConfig {
	stateDir: string;
	enabled?: boolean;
	repoPath?: string;
	runGit?: GitRunner;
}

export function getDefaultPionRepoPath(): string {
	return resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

export class RepoUpdateChecker {
	private readonly stateFile: string;
	private readonly enabled: boolean;
	private readonly repoPath: string;
	private readonly runGit: GitRunner;

	constructor(config: RepoUpdateCheckerConfig) {
		this.stateFile = join(config.stateDir, "repo-update-state.json");
		this.enabled = config.enabled ?? true;
		this.repoPath = config.repoPath ? expandTilde(config.repoPath) : getDefaultPionRepoPath();
		this.runGit = config.runGit ?? createGitRunner(this.repoPath);
	}

	async checkNow(now = new Date()): Promise<RepoUpdateStatus> {
		if (!this.enabled) {
			const status: RepoUpdateStatus = {
				kind: "disabled",
				repoPath: this.repoPath,
				checkedAt: now.toISOString(),
			};
			this.writeState({ ...this.readState(), lastStatus: status });
			return status;
		}

		const status = await this.inspectRepo(now);
		this.writeState({ ...this.readState(), lastStatus: status });
		return status;
	}

	async getAutomaticSystemNote(now = new Date()): Promise<string | null> {
		if (!this.enabled) {
			return null;
		}

		const today = toDayStamp(now);
		const state = this.readState();
		if (state.lastAutomaticDay === today) {
			return null;
		}

		let status = state.lastStatus;
		if (!status || toDayStamp(status.checkedAt) !== today) {
			status = await this.inspectRepo(now);
			state.lastStatus = status;
		}

		state.lastAutomaticDay = today;
		let note: string | null = null;
		if (
			status.kind === "behind" &&
			status.stateKey &&
			status.stateKey !== state.lastInjectedStateKey
		) {
			state.lastInjectedStateKey = status.stateKey;
			note = buildRepoUpdateSystemNote(status);
		}

		this.writeState(state);
		return note;
	}

	private async inspectRepo(now: Date): Promise<RepoUpdateStatus> {
		const checkedAt = now.toISOString();
		const insideWorkTree = await this.git(["rev-parse", "--is-inside-work-tree"]);
		if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
			return {
				kind: "not-repo",
				repoPath: this.repoPath,
				checkedAt,
				error: summarizeGitError(insideWorkTree),
			};
		}

		const topLevel = await this.git(["rev-parse", "--show-toplevel"]);
		const repoPath = topLevel.ok && topLevel.stdout ? topLevel.stdout : this.repoPath;

		const branchResult = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!branchResult.ok) {
			return {
				kind: "detached",
				repoPath,
				checkedAt,
				localHead: (await this.git(["rev-parse", "HEAD"])).stdout || undefined,
				dirty: await this.isDirty(),
			};
		}
		const branch = branchResult.stdout;

		const upstreamResult = await this.git([
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstreamResult.ok) {
			return {
				kind: "no-upstream",
				repoPath,
				checkedAt,
				branch,
				localHead: (await this.git(["rev-parse", "HEAD"])).stdout || undefined,
				dirty: await this.isDirty(),
				error: summarizeGitError(upstreamResult),
			};
		}
		const upstream = upstreamResult.stdout;

		const fetchResult = await this.git(["fetch", "--quiet", "--prune"]);
		if (!fetchResult.ok) {
			return {
				kind: "fetch-failed",
				repoPath,
				checkedAt,
				branch,
				upstream,
				localHead: (await this.git(["rev-parse", "HEAD"])).stdout || undefined,
				dirty: await this.isDirty(),
				error: summarizeGitError(fetchResult),
			};
		}

		const [localHeadResult, upstreamHeadResult, countsResult, dirty] = await Promise.all([
			this.git(["rev-parse", "HEAD"]),
			this.git(["rev-parse", "@{upstream}"]),
			this.git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
			this.isDirty(),
		]);

		const localHead = localHeadResult.stdout || undefined;
		const upstreamHead = upstreamHeadResult.stdout || undefined;
		const { aheadCount, behindCount } = parseAheadBehindCounts(countsResult.stdout);
		const stateKey = upstream && upstreamHead ? `${upstream}@${shortSha(upstreamHead)}` : undefined;

		if (aheadCount > 0 && behindCount > 0) {
			return {
				kind: "diverged",
				repoPath,
				checkedAt,
				branch,
				upstream,
				localHead,
				upstreamHead,
				aheadCount,
				behindCount,
				dirty,
				stateKey,
			};
		}

		if (behindCount > 0) {
			return {
				kind: "behind",
				repoPath,
				checkedAt,
				branch,
				upstream,
				localHead,
				upstreamHead,
				aheadCount,
				behindCount,
				dirty,
				stateKey,
			};
		}

		if (aheadCount > 0) {
			return {
				kind: "ahead",
				repoPath,
				checkedAt,
				branch,
				upstream,
				localHead,
				upstreamHead,
				aheadCount,
				behindCount,
				dirty,
				stateKey,
			};
		}

		return {
			kind: "up-to-date",
			repoPath,
			checkedAt,
			branch,
			upstream,
			localHead,
			upstreamHead,
			aheadCount,
			behindCount,
			dirty,
			stateKey,
		};
	}

	private async isDirty(): Promise<boolean> {
		const result = await this.git(["status", "--porcelain", "--untracked-files=no"]);
		return result.ok && result.stdout.length > 0;
	}

	private async git(args: string[]): Promise<GitCommandResult & { ok: boolean }> {
		try {
			const result = await this.runGit(args);
			return {
				...result,
				stdout: result.stdout.trim(),
				stderr: result.stderr.trim(),
				ok: result.exitCode === 0,
			};
		} catch (error) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				ok: false,
			};
		}
	}

	private readState(): RepoUpdateCheckerState {
		if (!existsSync(this.stateFile)) {
			return {};
		}

		try {
			return JSON.parse(readFileSync(this.stateFile, "utf-8")) as RepoUpdateCheckerState;
		} catch {
			return {};
		}
	}

	private writeState(state: RepoUpdateCheckerState): void {
		mkdirSync(dirname(this.stateFile), { recursive: true });
		writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	}
}

export function buildRepoUpdateSystemNote(status: RepoUpdateStatus): string {
	if (status.kind !== "behind") {
		throw new Error("System notes are only defined for behind statuses.");
	}

	return [
		`[SYSTEM] Pion runtime note: this checkout is behind its git upstream${status.upstream ? ` (${status.upstream})` : ""} by ${status.behindCount ?? 0} commit(s).`,
		status.localHead ? `Local HEAD: ${shortSha(status.localHead)}` : undefined,
		status.upstreamHead ? `Upstream HEAD: ${shortSha(status.upstreamHead)}` : undefined,
		"This note is hidden from the user.",
		"Decide whether mentioning the available update is useful in context.",
		"Do not claim any update was applied.",
		"Only guide or perform an update if the user explicitly asks.",
	]
		.filter((line): line is string => !!line)
		.join("\n");
}

export function formatRepoUpdateStatus(status: RepoUpdateStatus): string {
	const lines = [
		status.kind === "behind"
			? "Update available for Pion."
			: status.kind === "up-to-date"
				? "Pion is up to date with its upstream."
				: status.kind === "disabled"
					? "Repo update checks are disabled in config."
					: `Pion repo update status: ${status.kind}.`,
		`checked: ${status.checkedAt}`,
		`repo: ${status.repoPath}`,
	];

	if (status.branch) lines.push(`branch: ${status.branch}`);
	if (status.upstream) lines.push(`upstream: ${status.upstream}`);

	if (status.kind === "behind") {
		lines.push(`status: behind by ${status.behindCount ?? 0} commit(s)`);
	} else if (status.kind === "ahead") {
		lines.push(`status: ahead by ${status.aheadCount ?? 0} commit(s)`);
	} else if (status.kind === "diverged") {
		lines.push(
			`status: diverged (${status.aheadCount ?? 0} ahead, ${status.behindCount ?? 0} behind)`,
		);
	}

	if (status.localHead) lines.push(`local: ${shortSha(status.localHead)}`);
	if (status.upstreamHead) lines.push(`upstream head: ${shortSha(status.upstreamHead)}`);
	if (typeof status.dirty === "boolean") {
		lines.push(`working tree: ${status.dirty ? "dirty" : "clean"}`);
	}
	if (status.error) lines.push(`note: ${status.error}`);

	return lines.join("\n");
}

function parseAheadBehindCounts(value: string): { aheadCount: number; behindCount: number } {
	const [aheadRaw = "0", behindRaw = "0"] = value.split(/\s+/);
	const aheadCount = Number.parseInt(aheadRaw, 10);
	const behindCount = Number.parseInt(behindRaw, 10);
	return {
		aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
		behindCount: Number.isFinite(behindCount) ? behindCount : 0,
	};
}

function shortSha(value: string): string {
	return value.slice(0, 7);
}

function summarizeGitError(
	result: Pick<GitCommandResult, "stderr" | "stdout">,
): string | undefined {
	return result.stderr || result.stdout || undefined;
}

function toDayStamp(value: Date | string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	return date.toISOString().slice(0, 10);
}

function createGitRunner(repoPath: string): GitRunner {
	return async (args: string[]) => {
		const child = spawn("git", ["-C", repoPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

		const exitCode = await new Promise<number>((resolvePromise, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolvePromise(code ?? 1));
		});

		return {
			exitCode,
			stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
			stderr: Buffer.concat(stderrChunks).toString("utf-8"),
		};
	};
}
