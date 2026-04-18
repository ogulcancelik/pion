import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	AuthStorage,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	createBashToolDefinition,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config/schema.js";
import type { Message } from "../providers/types.js";
import { getAuthPath } from "./auth.js";
import {
	buildContinuationSeedPrompt,
	buildHandoffPrompt,
	extractHandoffBlock,
} from "./compactor.js";
import { prepareInboundMessage } from "./inbound.js";
import { expandTilde, homeDir } from "./paths.js";
import { PionResourceLoader } from "./pion-resource-loader.js";
import { createRecallTools } from "./recall-tools.js";
import {
	type RuntimeEvent,
	RuntimeEventBus,
	type RuntimeEventListener,
	createPiRuntimeEvent,
} from "./runtime-events.js";
import { resolveAgentCwd } from "./workspace.js";

/** Warning thresholds for context usage */
const WARN_THRESHOLD_85 = 85;
const WARN_THRESHOLD_95 = 95;
export const DEFAULT_BASH_TIMEOUT_SEC = 300;

export interface RunnerConfig {
	/** Base data directory (default: ~/.pion) */
	dataDir?: string;
	/** Path to auth storage (default: ~/.pion/auth.json) */
	authPath?: string;
	/** Directory containing skills (default: ~/.pion/skills) */
	skillsDir?: string;
	/** Optional global model override for session recall queries. */
	recallQueryModel?: string;
	/** Default timeout for bash tool calls in seconds. */
	bashTimeoutSec?: number;
	/** Optional dotenv-style env file loaded into tool subprocesses like bash. */
	toolEnvFile?: string;
	/** Shared runtime event bus for Pi SDK + daemon events */
	runtimeEventBus?: RuntimeEventBus;
}

export interface RunnerContext {
	agentConfig: AgentConfig;
	contextKey: string;
	/** Custom tools to register (e.g., Telegram sticker tool) */
	customTools?: ToolDefinition[];
}

export interface ProcessResult {
	response: string;
	/** System warnings to send before the response */
	warnings: string[];
}

export interface CompactSessionOptions {
	focus?: string;
	isCancelled?: () => boolean;
	pendingUserMessage?: string;
}

export interface CompactSessionResult {
	archivedSessionFile?: string;
	handoff: string;
}

export interface RunnerProcessOptions {
	onTextBlock?: (text: string) => void;
	onEvent?: (event: RuntimeEvent) => void;
	isCancelled?: () => boolean;
}

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Warning state per session */
interface WarningState {
	warned85: boolean;
	warned95: boolean;
}

export function parseModelString(modelString: string): [string, string] {
	const slashIndex = modelString.indexOf("/");
	if (slashIndex > 0 && slashIndex < modelString.length - 1) {
		return [modelString.slice(0, slashIndex), modelString.slice(slashIndex + 1)];
	}
	// Default to anthropic if no provider specified
	return ["anthropic", modelString];
}

export class UserFacingError extends Error {
	constructor(
		message: string,
		public readonly userMessage: string,
	) {
		super(message);
		this.name = "UserFacingError";
	}
}

export function getUserFacingErrorMessage(
	error: unknown,
	fallback = "Sorry, I encountered an error. Please try again.",
): string {
	return error instanceof UserFacingError ? error.userMessage : fallback;
}

export type RuntimeErrorDisposition =
	| {
			kind: "retry-with-runtime-note";
			additionalGuidance?: string;
			dropImages?: boolean;
	  }
	| {
			kind: "user-facing-fallback";
			userMessage: string;
	  }
	| { kind: "rethrow" };

export function classifyRuntimeError(
	error: unknown,
	images?: Array<{ type: "image"; data: string; mimeType: string }>,
): RuntimeErrorDisposition {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();

	const unsupportedImage =
		!!images?.length &&
		(message.includes("image.source.base64.media_type") ||
			message.includes("Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'"));
	if (unsupportedImage) {
		return {
			kind: "retry-with-runtime-note",
			dropImages: true,
			additionalGuidance:
				"The retry is being sent without the attached images because the previous attempt failed while processing them.",
		};
	}

	if (
		normalized.includes("no api key found") ||
		normalized.includes("authentication failed") ||
		normalized.includes("invalid api key") ||
		normalized.includes("unauthorized") ||
		normalized.includes("forbidden")
	) {
		return {
			kind: "user-facing-fallback",
			userMessage:
				"I hit an upstream authentication/configuration problem and can't answer right now. Please try again later.",
		};
	}

	if (
		normalized.includes("rate limit") ||
		normalized.includes("too many requests") ||
		normalized.includes("credits") ||
		normalized.includes("quota") ||
		normalized.includes("insufficient")
	) {
		return {
			kind: "user-facing-fallback",
			userMessage:
				"The upstream AI provider is currently rate-limited or out of quota, so I can't answer right now. Please try again later.",
		};
	}

	if (
		normalized.includes("overloaded") ||
		normalized.includes("service unavailable") ||
		normalized.includes("internal server error") ||
		normalized.includes("bad gateway") ||
		normalized.includes("gateway timeout") ||
		normalized.includes("timed out") ||
		normalized.includes("timeout") ||
		normalized.includes("econnreset") ||
		normalized.includes("network")
	) {
		return {
			kind: "user-facing-fallback",
			userMessage:
				"The upstream AI provider is temporarily unavailable, so I can't answer right now. Please try again in a bit.",
		};
	}

	return { kind: "rethrow" };
}

export function createManagedBashToolDefinition(
	cwd: string,
	defaultTimeoutSec = DEFAULT_BASH_TIMEOUT_SEC,
	options?: BashToolOptions,
): ReturnType<typeof createBashToolDefinition> {
	const base = createBashToolDefinition(cwd, options);
	return {
		...base,
		description: `${base.description} If timeout is omitted, it defaults to ${defaultTimeoutSec} seconds in Pion.`,
		async execute(toolCallId, params: BashToolInput, signal, onUpdate, ctx) {
			return base.execute(
				toolCallId,
				{ ...params, timeout: params.timeout ?? defaultTimeoutSec },
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}

type RetryBranchEntry = {
	id?: string;
	type?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: unknown;
	};
};

export function findRetryBranchParentId(
	branchEntries: RetryBranchEntry[],
): string | null | undefined {
	const assistantError = branchEntries.at(-1);
	const failedUserTurn = branchEntries.at(-2);
	if (
		assistantError?.type !== "message" ||
		assistantError.message?.role !== "assistant" ||
		assistantError.message?.stopReason !== "error" ||
		failedUserTurn?.type !== "message" ||
		failedUserTurn.message?.role !== "user"
	) {
		return undefined;
	}
	const hasImage = Array.isArray(failedUserTurn.message.content)
		? failedUserTurn.message.content.some(
				(part) =>
					typeof part === "object" && part !== null && "type" in part && part.type === "image",
			)
		: false;
	if (!hasImage) {
		return undefined;
	}
	return failedUserTurn.parentId ?? null;
}

export function buildRuntimeErrorSystemPrompt(
	basePrompt: string,
	errorMessage: string,
	additionalGuidance?: string,
): string {
	return `${basePrompt}\n\n<System note>\nThe previous attempt failed with this runtime/provider error:\n${errorMessage}\n\nThis note is from the runtime and is not visible to the user. Continue the conversation with this in mind.${additionalGuidance ? `\n\n${additionalGuidance}` : ""}\n</System note>`;
}

export function loadToolEnvFile(envFilePath?: string): Record<string, string> {
	if (!envFilePath) {
		return {};
	}

	const resolvedPath = expandTilde(envFilePath);
	if (!existsSync(resolvedPath)) {
		return {};
	}

	const content = readFileSync(resolvedPath, "utf-8");
	const env: Record<string, string> = {};

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
		const equalsIndex = normalizedLine.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}

		const key = normalizedLine.slice(0, equalsIndex).trim();
		if (!key) {
			continue;
		}

		let value = normalizedLine.slice(equalsIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		env[key] = value;
	}

	return env;
}

/**
 * Runner manages pi-agent sessions and processes messages.
 *
 * Each unique contextKey gets its own session (conversation history).
 */
export class Runner {
	private dataDir: string;
	private skillsDir: string;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private runtimeEventBus: RuntimeEventBus;
	private recallQueryModel?: string;
	private bashTimeoutSec: number;
	private toolEnv: Record<string, string>;
	private sessions: Map<string, RunnerSession> = new Map();
	private warningState: Map<string, WarningState> = new Map();

	constructor(config: RunnerConfig = {}) {
		const home = homeDir();
		this.dataDir = config.dataDir ? expandTilde(config.dataDir) : join(home, ".pion");
		this.skillsDir = config.skillsDir ? expandTilde(config.skillsDir) : join(home, ".pion/skills");
		const authPath = getAuthPath(config);

		// Ensure data directory exists
		mkdirSync(this.dataDir, { recursive: true });
		mkdirSync(join(this.dataDir, "sessions"), { recursive: true });

		this.authStorage = AuthStorage.create(authPath);
		// Explicitly set models.json path to workspace dir
		const modelsJsonPath = join(this.dataDir, "agents/main/models.json");
		this.modelRegistry = ModelRegistry.create(this.authStorage, modelsJsonPath);
		this.runtimeEventBus = config.runtimeEventBus ?? new RuntimeEventBus(this.dataDir);
		this.recallQueryModel = config.recallQueryModel;
		this.bashTimeoutSec = config.bashTimeoutSec ?? DEFAULT_BASH_TIMEOUT_SEC;
		this.toolEnv = loadToolEnvFile(config.toolEnvFile);
	}

	/**
	 * Process a message and return the response with any warnings.
	 */
	async process(
		message: Message,
		context: RunnerContext,
		options: RunnerProcessOptions = {},
	): Promise<ProcessResult> {
		const session = await this.ensureSession(context);

		if (options.isCancelled?.()) return { response: "", warnings: [] };

		const mediaDir = join(tmpdir(), "pion-media", context.contextKey.replace(/[:/\\]/g, "-"));
		const preparedInbound = await prepareInboundMessage(message, mediaDir);
		if (preparedInbound.message.attachments.length > 0) {
			console.log(
				`[runner] Stored ${preparedInbound.message.attachments.length} attachment(s) for ${context.contextKey}: ${preparedInbound.message.attachments.map((attachment) => attachment.path).join(", ")}`,
			);
		}

		if (options.isCancelled?.()) return { response: "", warnings: [] };

		const response = await session.prompt(preparedInbound.promptText, undefined, options);

		if (options.isCancelled?.()) return { response: "", warnings: [] };

		// Check for context warnings
		const warnings = this.checkContextWarnings(context.contextKey, session);

		return { response, warnings };
	}

	/**
	 * Check context usage and return any warnings.
	 */
	private checkContextWarnings(contextKey: string, session: RunnerSession): string[] {
		const warnings: string[] = [];
		const usage = session.getContextUsage();
		if (!usage || usage.percent === null) return warnings;

		const pct = Math.round(usage.percent);
		let state = this.warningState.get(contextKey);
		if (!state) {
			state = { warned85: false, warned95: false };
			this.warningState.set(contextKey, state);
		}

		if (pct >= WARN_THRESHOLD_95 && !state.warned95) {
			state.warned95 = true;
			warnings.push(
				`⚠️ Context at ${pct}% capacity - running low!\n\nCommands: /new (fresh start) or /compact (summarize & continue)`,
			);
		} else if (pct >= WARN_THRESHOLD_85 && !state.warned85) {
			state.warned85 = true;
			warnings.push(
				`⚠️ Context at ${pct}% capacity\n\nCommands: /new (fresh start) or /compact (summarize & continue)`,
			);
		}

		return warnings;
	}

	subscribeRuntimeEvents(listener: RuntimeEventListener): () => void {
		return this.runtimeEventBus.subscribe(listener);
	}

	getRuntimeEventFile(contextKey: string): string {
		return this.runtimeEventBus.getEventLogFile(contextKey);
	}

	async getContextUsage(context: RunnerContext): Promise<ContextUsageSnapshot | null> {
		const session = await this.ensureSession(context);
		return session.getContextUsage();
	}

	async compact(
		context: RunnerContext,
		options: CompactSessionOptions = {},
	): Promise<CompactSessionResult> {
		const session = await this.ensureSession(context);
		const handoff = await session.generateHandoff(options);
		if (options.isCancelled?.()) {
			return { handoff };
		}
		const archivedSessionFile = this.archiveAndClearSession(context.contextKey);
		this.primeSessionWithUserPrompt(
			context.contextKey,
			buildContinuationSeedPrompt(handoff, archivedSessionFile),
			context.agentConfig.cwd ?? context.agentConfig.workspace,
		);
		return { archivedSessionFile, handoff };
	}

	private async ensureSession(context: RunnerContext): Promise<RunnerSession> {
		let session = this.sessions.get(context.contextKey);
		if (!session) {
			session = await this.createSession(context);
			this.sessions.set(context.contextKey, session);
		}
		if (typeof (session as { initialize?: () => Promise<void> }).initialize === "function") {
			await (session as { initialize: () => Promise<void> }).initialize();
		}
		return session;
	}

	private async createSession(context: RunnerContext): Promise<RunnerSession> {
		// Build session file path from context key
		// telegram:contact:123 → sessions/telegram-contact-123.jsonl
		const safeKey = context.contextKey.replace(/[:/\\]/g, "-");
		const sessionFile = join(this.dataDir, "sessions", `${safeKey}.jsonl`);

		return new RunnerSession({
			agentConfig: context.agentConfig,
			contextKey: context.contextKey,
			sessionFile,
			skillsDir: this.skillsDir,
			modelRegistry: this.modelRegistry,
			runtimeEventBus: this.runtimeEventBus,
			recallQueryModel: this.recallQueryModel,
			bashTimeoutSec: this.bashTimeoutSec,
			toolEnv: this.toolEnv,
			customTools: context.customTools,
		});
	}

	/**
	 * Get session file path for a context key.
	 */
	getSessionFile(contextKey: string): string {
		const safeKey = contextKey.replace(/[:/\\]/g, "-");
		return join(this.dataDir, "sessions", `${safeKey}.jsonl`);
	}

	/**
	 * Clear a session (memory + archive file) and reset warnings.
	 */
	clearSession(contextKey: string): boolean {
		const hadSession = this.sessions.has(contextKey);
		this.archiveAndClearSession(contextKey);
		return hadSession;
	}

	private archiveAndClearSession(contextKey: string): string | undefined {
		this.sessions.delete(contextKey);
		const sessionFile = this.getSessionFile(contextKey);
		const archivedSessionFile = existsSync(sessionFile)
			? this.archiveSession(sessionFile, contextKey)
			: undefined;
		this.warningState.delete(contextKey);
		return archivedSessionFile;
	}

	/**
	 * Archive a session file with its creation timestamp.
	 */
	private archiveSession(sessionFile: string, contextKey: string): string | undefined {
		try {
			// Get creation time from first line
			const content = readFileSync(sessionFile, "utf-8");
			const firstLine = content.split("\n")[0];
			if (!firstLine) {
				// Empty file, just delete
				const emptyPath = `${sessionFile}.empty`;
				renameSync(sessionFile, emptyPath);
				this.runtimeEventBus.removeSessionFile(sessionFile);
				return emptyPath;
			}

			const firstEntry = JSON.parse(firstLine);
			const timestamp = firstEntry.timestamp || new Date().toISOString();
			const createdSlug = timestamp.slice(0, 16).replace(/[:.]/g, "-");

			// Build archive path
			const safeKey = contextKey.replace(/[:/\\]/g, "-");
			const archiveDir = join(this.dataDir, "sessions", "archive");
			mkdirSync(archiveDir, { recursive: true });

			const archivePath = join(archiveDir, `${safeKey}-${createdSlug}.jsonl`);

			// Handle collision (multiple archives same minute)
			let finalPath = archivePath;
			let counter = 1;
			while (existsSync(finalPath)) {
				finalPath = archivePath.replace(".jsonl", `-${counter}.jsonl`);
				counter++;
			}

			renameSync(sessionFile, finalPath);
			this.runtimeEventBus.removeSessionFile(sessionFile);
			this.runtimeEventBus.syncSessionFile(finalPath);
			console.log(`[runner] Archived session to ${finalPath}`);
			return finalPath;
		} catch (err) {
			// If archiving fails, log but don't block
			console.error("[runner] Failed to archive session:", err);
			return undefined;
		}
	}

	primeSessionWithUserPrompt(contextKey: string, promptText: string, cwd?: string): void {
		this.clearSession(contextKey);
		const sessionFile = this.getSessionFile(contextKey);
		const timestamp = new Date().toISOString();
		const id = Math.random().toString(36).slice(2, 10);

		// Session header
		const sessionEntry = {
			type: "session",
			version: 3,
			id: `compacted-${id}`,
			timestamp,
			cwd: cwd ? expandTilde(cwd) : process.cwd(),
		};

		const messageEntry = {
			type: "message",
			id: `summary-${id}`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		};
		const assistantEntry = {
			type: "message",
			id: `summary-ack-${id}`,
			parentId: messageEntry.id,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "[Runtime note: handoff loaded for the next turn.]" }],
				api: "pion-synthetic",
				provider: "pion",
				model: "compaction-handoff",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				// Mark synthetic handoff acks as non-usage-bearing so context accounting
				// skips them and falls back to the last real model response.
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		};

		writeFileSync(
			sessionFile,
			`${JSON.stringify(sessionEntry)}\n${JSON.stringify(messageEntry)}\n${JSON.stringify(assistantEntry)}\n`,
		);
		this.runtimeEventBus.syncSessionFile(sessionFile);
	}

	/**
	 * Start a new session with an initial summary message.
	 * Used after compaction.
	 *
	 * Writes in pi-agent session format so SessionManager picks it up.
	 */
	primeSessionWithSummary(contextKey: string, summary: string, cwd?: string): void {
		this.primeSessionWithUserPrompt(contextKey, `[Previous session summary]\n\n${summary}`, cwd);
	}

	appendAssistantMessage(contextKey: string, text: string, cwd?: string): void {
		const sessionFile = this.getSessionFile(contextKey);
		const timestamp = new Date().toISOString();
		const id = Math.random().toString(36).slice(2, 10);

		if (!existsSync(sessionFile)) {
			const sessionEntry = {
				type: "session",
				version: 3,
				id: `synthetic-${id}`,
				timestamp,
				cwd: cwd ? expandTilde(cwd) : process.cwd(),
			};
			writeFileSync(sessionFile, `${JSON.stringify(sessionEntry)}\n`, "utf-8");
		}

		const content = readFileSync(sessionFile, "utf-8");
		const lastMessageId = content
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as { type?: string; id?: string };
				} catch {
					return null;
				}
			})
			.filter((entry): entry is { type?: string; id?: string } => entry !== null)
			.filter((entry) => entry.type === "message" && typeof entry.id === "string")
			.at(-1)?.id;

		const messageEntry = {
			type: "message",
			id: `scheduled-${id}`,
			parentId: lastMessageId ?? null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "pion-synthetic",
				provider: "pion",
				model: "scheduled-delivery",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				// Mark synthetic deliveries as non-usage-bearing so downstream context accounting
				// skips them and falls back to the last real model response.
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		};

		writeFileSync(sessionFile, `${JSON.stringify(messageEntry)}\n`, {
			encoding: "utf-8",
			flag: "a",
		});
		this.runtimeEventBus.syncSessionFile(sessionFile);
	}

	/**
	 * Get all active session keys.
	 */
	getActiveContextKeys(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Check if a session is currently streaming (processing).
	 */
	isStreaming(contextKey: string): boolean {
		const session = this.sessions.get(contextKey);
		return session?.isStreaming ?? false;
	}

	/**
	 * Steer an active session mid-response.
	 * Returns true if steering was applied, false if session wasn't streaming.
	 */
	async steer(contextKey: string, text: string): Promise<boolean> {
		const session = this.sessions.get(contextKey);
		if (!session || !session.isStreaming) {
			return false;
		}

		await session.steer(text);
		return true;
	}

	/**
	 * Abort an active session immediately.
	 * Clears queued messages and waits for the agent loop to stop.
	 * Returns true if abort was triggered, false if nothing was running.
	 */
	async abort(contextKey: string): Promise<boolean> {
		const session = this.sessions.get(contextKey);
		if (!session || !session.isStreaming) {
			return false;
		}

		await session.abort();
		return true;
	}
}

interface RunnerSessionConfig {
	agentConfig: AgentConfig;
	contextKey: string;
	sessionFile: string;
	skillsDir: string;
	modelRegistry: ModelRegistry;
	runtimeEventBus: RuntimeEventBus;
	recallQueryModel?: string;
	bashTimeoutSec: number;
	toolEnv: Record<string, string>;
	customTools?: ToolDefinition[];
}

/**
 * A single agent session for one conversation context.
 */
class RunnerSession {
	private config: RunnerSessionConfig;
	private initialized = false;
	private agentSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	private sessionManager: SessionManager | null = null;

	constructor(config: RunnerSessionConfig) {
		this.config = config;
	}

	/**
	 * Check if the session is currently streaming (processing a prompt).
	 */
	get isStreaming(): boolean {
		return this.agentSession?.isStreaming ?? false;
	}

	/**
	 * Get context usage from the underlying agent session.
	 */
	getContextUsage(): ContextUsageSnapshot | null {
		const usage = this.agentSession?.getContextUsage();
		if (!usage) return null;
		return {
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			percent: usage.percent,
		};
	}

	/**
	 * Steer the agent mid-response. Injects message after current tool call.
	 * Only call when isStreaming is true.
	 */
	async steer(text: string): Promise<void> {
		if (!this.agentSession) {
			throw new Error("Session not initialized");
		}

		// Add timestamp prefix like normal prompts
		const now = new Date().toISOString();
		let messagePrefix = `[${now}`;
		const usage = this.agentSession.getContextUsage();
		if (usage && usage.percent !== null) {
			const pct = Math.round(usage.percent);
			messagePrefix += ` | Context: ${pct}%`;
		}
		messagePrefix += "]\n\n";

		// Use pi-agent's steering - injects after current tool
		await this.agentSession.prompt(messagePrefix + text, {
			streamingBehavior: "steer",
		});
	}

	/**
	 * Abort the current processing immediately.
	 * Clears all queued messages and waits for the agent loop to stop.
	 */
	async abort(): Promise<void> {
		if (!this.agentSession) {
			return;
		}
		// Clear steering + followUp queues so they don't fire after abort
		this.agentSession.agent.clearAllQueues();
		// Abort + wait for the agent loop to actually terminate
		await this.agentSession.abort();
	}

	async generateHandoff(options: CompactSessionOptions = {}): Promise<string> {
		const response = await this.prompt(buildHandoffPrompt(options), undefined, {
			isCancelled: options.isCancelled,
		});
		const handoff = extractHandoffBlock(response);
		if (!handoff) {
			throw new Error("Compaction handoff did not include a valid delimited block");
		}
		return handoff;
	}

	async prompt(
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		options: RunnerProcessOptions = {},
	): Promise<string> {
		if (!this.initialized) {
			await this.initialize();
		}

		if (options.isCancelled?.()) return "";

		if (!this.agentSession) {
			throw new Error("Session not initialized");
		}

		// Collect all text blocks for the full response
		const textBlocks: string[] = [];

		// Subscribe to the full Pi SDK event stream and fan it out into Pion runtime events.
		const unsubscribe = this.agentSession.subscribe((event: AgentSessionEvent) => {
			const runtimeEvent = this.config.runtimeEventBus.emit(
				createPiRuntimeEvent(this.config.contextKey, this.config.sessionFile, event),
			);
			options.onEvent?.(runtimeEvent);

			// Keep the legacy text-block behavior as a derived view over the richer event stream.
			if (event.type === "message_end" && event.message.role === "assistant") {
				const msg = event.message;
				const text = msg.content
					.filter((c: { type: string }) => c.type === "text")
					.map((c: { type: string; text?: string }) => c.text || "")
					.join("\n")
					.trim();

				if (text) {
					textBlocks.push(text);
					options.onTextBlock?.(text);
				}
			}
		});

		try {
			await this.agentSession.reload();
			const freshSystemPrompt = this.agentSession.agent.state.systemPrompt;

			const now = new Date().toISOString();
			let messagePrefix = `[${now}`;

			const usage = this.agentSession.getContextUsage();
			if (usage && usage.percent !== null) {
				const pct = Math.round(usage.percent);
				messagePrefix += ` | Context: ${pct}%`;
			}
			messagePrefix += "]\n\n";

			try {
				await this.agentSession.prompt(messagePrefix + text, images ? { images } : undefined);
			} catch (error) {
				const disposition = classifyRuntimeError(error, images);
				if (disposition.kind === "rethrow") {
					throw error;
				}
				if (disposition.kind === "user-facing-fallback") {
					const errorMessage = error instanceof Error ? error.message : String(error);
					throw new UserFacingError(errorMessage, disposition.userMessage);
				}

				const errorMessage = error instanceof Error ? error.message : String(error);
				if (disposition.dropImages) {
					this.rewindFailedTurnForRetry();
				}
				this.agentSession.agent.state.systemPrompt = buildRuntimeErrorSystemPrompt(
					freshSystemPrompt,
					errorMessage,
					disposition.additionalGuidance,
				);
				await this.agentSession.prompt(
					messagePrefix + text,
					disposition.dropImages ? undefined : images ? { images } : undefined,
				);
				this.agentSession.agent.state.systemPrompt = freshSystemPrompt;
			}

			return textBlocks.join("\n\n");
		} finally {
			this.config.runtimeEventBus.syncSessionFile(this.config.sessionFile);
			unsubscribe();
		}
	}

	private rewindFailedTurnForRetry(): void {
		if (!this.agentSession || !this.sessionManager) {
			return;
		}
		const branchParentId = findRetryBranchParentId(this.sessionManager.getBranch());
		if (branchParentId === undefined) {
			return;
		}
		if (branchParentId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(branchParentId);
		}
		this.agentSession.agent.state.messages = this.sessionManager.buildSessionContext().messages;
	}

	async initialize(): Promise<void> {
		const resolvedCwd = resolveAgentCwd(this.config.agentConfig);
		// Parse model string: "anthropic/claude-sonnet-4-20250514" → provider + modelId
		const [provider, modelId] = parseModelString(this.config.agentConfig.model);

		// Find the model
		const model = await this.config.modelRegistry.find(provider, modelId);

		if (!model) {
			throw new Error(`Model not found: ${this.config.agentConfig.model}`);
		}

		// Ensure session file directory exists
		const sessionDir = dirname(this.config.sessionFile);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// Create session manager pointing to our session file
		const sessionManager = SessionManager.create(resolvedCwd, sessionDir);
		sessionManager.setSessionFile(this.config.sessionFile);
		this.sessionManager = sessionManager;

		// Create the agent session
		const recallTools = createRecallTools({
			searchSessionMessages: (query, limit) =>
				this.config.runtimeEventBus.searchSessionMessages(query, limit),
			recallQueryModel: this.config.recallQueryModel,
		});
		const managedBashTool = createManagedBashToolDefinition(
			resolvedCwd,
			this.config.bashTimeoutSec,
			{
				spawnHook: ({ command, cwd, env }) => ({
					command,
					cwd,
					env: { ...env, ...this.config.toolEnv },
				}),
			},
		);

		const result = await createAgentSession({
			model,
			thinkingLevel: this.config.agentConfig.thinkingLevel,
			cwd: resolvedCwd,
			sessionManager,
			modelRegistry: this.config.modelRegistry,
			resourceLoader: new PionResourceLoader(this.config.agentConfig, this.config.skillsDir),
			tools: [
				createReadTool(resolvedCwd),
				createEditTool(resolvedCwd),
				createWriteTool(resolvedCwd),
			],
			// Custom tools (e.g., Telegram sticker tool) + native recall tools + managed bash
			customTools: [
				managedBashTool as unknown as ToolDefinition,
				...(this.config.customTools ?? []),
				...recallTools,
			],
		});

		this.agentSession = result.session;
		this.initialized = true;
		this.config.runtimeEventBus.syncSessionFile(this.config.sessionFile);
	}
}
