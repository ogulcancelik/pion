import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GitCommandResult,
	RepoUpdateChecker,
	type RepoUpdateStatus,
	formatRepoUpdateStatus,
} from "../../src/core/repo-update.js";

function createGitRunner(responses: Record<string, GitCommandResult>) {
	const calls: string[] = [];

	return {
		calls,
		run: async (args: string[]) => {
			const key = args.join(" ");
			calls.push(key);
			const response = responses[key];
			if (!response) {
				throw new Error(`Unexpected git command: ${key}`);
			}
			return response;
		},
	};
}

function ok(stdout: string): GitCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function behindRepoResponses(): Record<string, GitCommandResult> {
	return {
		"rev-parse --is-inside-work-tree": ok("true\n"),
		"rev-parse --show-toplevel": ok("/tmp/pion\n"),
		"fetch --quiet --prune": ok(""),
		"symbolic-ref --quiet --short HEAD": ok("main\n"),
		"rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("origin/main\n"),
		"rev-parse HEAD": ok("1111111111111111111111111111111111111111\n"),
		"rev-parse @{upstream}": ok("2222222222222222222222222222222222222222\n"),
		"rev-list --left-right --count HEAD...@{upstream}": ok("0\t2\n"),
		"status --porcelain --untracked-files=no": ok(""),
	};
}

describe("RepoUpdateChecker", () => {
	test("reports behind status for manual checks", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pion-update-check-"));
		const git = createGitRunner(behindRepoResponses());
		const checker = new RepoUpdateChecker({
			stateDir,
			repoPath: "/tmp/pion",
			runGit: git.run,
		});

		const status = await checker.checkNow(new Date("2026-04-06T09:00:00.000Z"));

		expect(status.kind).toBe("behind");
		expect(status.behindCount).toBe(2);
		expect(status.branch).toBe("main");
		expect(status.upstream).toBe("origin/main");
		expect(status.stateKey).toBe("origin/main@2222222");
		expect(git.calls).toContain("fetch --quiet --prune");
	});

	test("injects a system note once per unseen upstream head", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pion-update-note-"));
		const firstGit = createGitRunner(behindRepoResponses());
		const checker = new RepoUpdateChecker({
			stateDir,
			repoPath: "/tmp/pion",
			runGit: firstGit.run,
		});

		const firstNote = await checker.getAutomaticSystemNote(new Date("2026-04-06T10:00:00.000Z"));
		expect(firstNote).toContain("behind its git upstream");
		expect(firstNote).toContain("2 commit(s)");
		expect(await checker.getAutomaticSystemNote(new Date("2026-04-06T12:00:00.000Z"))).toBeNull();

		const nextDaySameStateGit = createGitRunner(behindRepoResponses());
		const sameStateChecker = new RepoUpdateChecker({
			stateDir,
			repoPath: "/tmp/pion",
			runGit: nextDaySameStateGit.run,
		});
		expect(
			await sameStateChecker.getAutomaticSystemNote(new Date("2026-04-07T09:00:00.000Z")),
		).toBeNull();

		const nextDayNewHeadGit = createGitRunner({
			...behindRepoResponses(),
			"rev-parse @{upstream}": ok("3333333333333333333333333333333333333333\n"),
		});
		const newStateChecker = new RepoUpdateChecker({
			stateDir,
			repoPath: "/tmp/pion",
			runGit: nextDayNewHeadGit.run,
		});
		const secondNote = await newStateChecker.getAutomaticSystemNote(
			new Date("2026-04-08T09:00:00.000Z"),
		);
		expect(secondNote).toContain("3333333");
	});

	test("reuses same-day manual check result for the first real user message", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pion-update-cache-"));
		const git = createGitRunner(behindRepoResponses());
		const checker = new RepoUpdateChecker({
			stateDir,
			repoPath: "/tmp/pion",
			runGit: git.run,
		});

		await checker.checkNow(new Date("2026-04-06T08:00:00.000Z"));
		const note = await checker.getAutomaticSystemNote(new Date("2026-04-06T11:00:00.000Z"));

		expect(note).toContain("behind its git upstream");
		expect(git.calls.filter((call) => call === "fetch --quiet --prune")).toHaveLength(1);
	});
});

describe("formatRepoUpdateStatus", () => {
	test("formats behind status for /checkupdate output", () => {
		const text = formatRepoUpdateStatus({
			kind: "behind",
			repoPath: "/tmp/pion",
			checkedAt: "2026-04-06T09:00:00.000Z",
			branch: "main",
			upstream: "origin/main",
			localHead: "1111111111111111111111111111111111111111",
			upstreamHead: "2222222222222222222222222222222222222222",
			behindCount: 2,
			aheadCount: 0,
			dirty: false,
			stateKey: "origin/main@2222222",
		} satisfies RepoUpdateStatus);

		expect(text).toContain("Update available for Pion.");
		expect(text).toContain("status: behind by 2 commit(s)");
		expect(text).toContain("working tree: clean");
	});
});
