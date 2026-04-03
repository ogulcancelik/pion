import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config/schema.js";
import type { Message } from "../providers/types.js";
import { getAuthPath } from "./auth.js";
import { prepareInboundMessage } from "./inbound.js";
import { expandTilde, homeDir } from "./paths.js";
import { PionResourceLoader } from "./pion-resource-loader.js";
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

export interface RunnerConfig {
	/** Base data directory (default: ~/.pion) */
	dataDir?: string;
	/** Path to auth storage (default: ~/.pion/auth.json) */
	authPath?: string;
	/** Directory containing skills (default: ~/.pion/skills) */
	skillsDir?: string;
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

export interface RunnerProcessOptions {
	onTextBlock?: (text: string) => void;
	onEvent?: (event: RuntimeEvent) => void;
	isCancelled?: () => boolean;
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
	}

	/**
	 * Process a message and return the response with any warnings.
	 */
	async process(
		message: Message,
		context: RunnerContext,
		options: RunnerProcessOptions = {},
	): Promise<ProcessResult> {
		let session = this.sessions.get(context.contextKey);

		if (!session) {
			session = await this.createSession(context);
			this.sessions.set(context.contextKey, session);
		}

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
		if (!usage) return warnings;

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
		// Clear memory
		const hadSession = this.sessions.delete(contextKey);

		// Archive file instead of deleting
		const sessionFile = this.getSessionFile(contextKey);
		if (existsSync(sessionFile)) {
			this.archiveSession(sessionFile, contextKey);
		}

		// Reset warning state
		this.warningState.delete(contextKey);

		return hadSession;
	}

	/**
	 * Archive a session file with its creation timestamp.
	 */
	private archiveSession(sessionFile: string, contextKey: string): void {
		try {
			// Get creation time from first line
			const content = readFileSync(sessionFile, "utf-8");
			const firstLine = content.split("\n")[0];
			if (!firstLine) {
				// Empty file, just delete
				renameSync(sessionFile, `${sessionFile}.empty`);
				this.runtimeEventBus.removeSessionFile(sessionFile);
				return;
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
		} catch (err) {
			// If archiving fails, log but don't block
			console.error("[runner] Failed to archive session:", err);
		}
	}

	/**
	 * Start a new session with an initial summary message.
	 * Used after compaction.
	 *
	 * Writes in pi-agent session format so SessionManager picks it up.
	 */
	primeSessionWithSummary(contextKey: string, summary: string, cwd?: string): void {
		// Clear existing session first
		this.clearSession(contextKey);

		// Write in pi-agent JSONL format
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

		// Summary as user message in pi-agent format
		const messageEntry = {
			type: "message",
			id: `summary-${id}`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: `[Previous session summary]\n\n${summary}` }],
				timestamp: Date.now(),
			},
		};

		writeFileSync(
			sessionFile,
			`${JSON.stringify(sessionEntry)}\n${JSON.stringify(messageEntry)}\n`,
		);
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
	getContextUsage(): { percent: number } | null {
		const usage = this.agentSession?.getContextUsage();
		if (!usage || usage.percent === null) return null;
		return { percent: usage.percent };
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
				this.agentSession.agent.setSystemPrompt(
					buildRuntimeErrorSystemPrompt(
						freshSystemPrompt,
						errorMessage,
						disposition.additionalGuidance,
					),
				);
				await this.agentSession.prompt(
					messagePrefix + text,
					disposition.dropImages ? undefined : images ? { images } : undefined,
				);
				this.agentSession.agent.setSystemPrompt(freshSystemPrompt);
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

	private async initialize(): Promise<void> {
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
		const result = await createAgentSession({
			model,
			cwd: resolvedCwd,
			sessionManager,
			modelRegistry: this.config.modelRegistry,
			resourceLoader: new PionResourceLoader(this.config.agentConfig, this.config.skillsDir),
			// Custom tools (e.g., Telegram sticker tool)
			customTools: this.config.customTools,
		});

		this.agentSession = result.session;
		this.initialized = true;
		this.config.runtimeEventBus.syncSessionFile(this.config.sessionFile);
	}
}
