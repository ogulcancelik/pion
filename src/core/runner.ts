import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	createExtensionRuntime,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config/schema.js";
import type { Message } from "../providers/types.js";
import { getAuthPath } from "./auth.js";
import { expandTilde, homeDir } from "./paths.js";
import { buildSystemPromptWithSkills } from "./skills.js";

/**
 * Minimal no-op resource loader for pion.
 * Pion doesn't use pi's extension/skill/theme discovery — it manages its own.
 * This avoids the DefaultResourceLoader which shells out to `npm root -g`.
 */
function createNoOpResourceLoader(systemPrompt?: string): ResourceLoader {
	const emptyExtensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => emptyExtensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};
}

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
	}

	/**
	 * Process a message and return the response with any warnings.
	 *
	 * @param onMessage Called with each complete text block as the agent produces it
	 *   (e.g., text before a tool call, text between tool calls, final text).
	 *   Each call contains a full, self-contained message — no partial streams.
	 * @param isCancelled Optional callback checked at async boundaries.
	 *   If it returns true, processing is aborted early and the response is empty.
	 */
	async process(
		message: Message,
		context: RunnerContext,
		onMessage?: (text: string) => void,
		isCancelled?: () => boolean,
	): Promise<ProcessResult> {
		let session = this.sessions.get(context.contextKey);

		if (!session) {
			session = await this.createSession(context);
			this.sessions.set(context.contextKey, session);
		}

		if (isCancelled?.()) return { response: "", warnings: [] };

		const images = await this.fetchImages(message);

		if (isCancelled?.()) return { response: "", warnings: [] };

		const response = await session.prompt(message.text, images, onMessage, isCancelled);

		// Check for context warnings
		const warnings = this.checkContextWarnings(context.contextKey, session);

		return { response, warnings };
	}

	/**
	 * Fetch and convert media attachments to base64 images.
	 */
	private async fetchImages(
		message: Message,
	): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
		const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

		if (!message.media || message.media.length === 0) {
			return images;
		}

		for (const media of message.media) {
			// Only process images
			if (media.type !== "image") continue;

			try {
				let base64Data: string;
				let mimeType = media.mimeType || "image/jpeg";

				if (media.buffer) {
					// Already have buffer
					base64Data = media.buffer.toString("base64");
				} else if (media.url) {
					// Fetch from URL
					const response = await fetch(media.url);
					if (!response.ok) {
						console.warn(`[runner] Failed to fetch image: ${response.status}`);
						continue;
					}
					const buffer = await response.arrayBuffer();
					base64Data = Buffer.from(buffer).toString("base64");

					// Try to get mime type from response
					const contentType = response.headers.get("content-type");
					if (contentType) {
						mimeType = contentType.split(";")[0] || mimeType;
					}
				} else {
					continue;
				}

				images.push({
					type: "image",
					data: base64Data,
					mimeType,
				});
			} catch (err) {
				console.warn("[runner] Failed to process image:", err instanceof Error ? err.message : err);
			}
		}

		return images;
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
	primeSessionWithSummary(contextKey: string, summary: string): void {
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
			cwd: process.cwd(),
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
	customTools?: ToolDefinition[];
}

/**
 * A single agent session for one conversation context.
 */
class RunnerSession {
	private config: RunnerSessionConfig;
	private initialized = false;
	private agentSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

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
		onMessage?: (text: string) => void,
		isCancelled?: () => boolean,
	): Promise<string> {
		if (!this.initialized) {
			await this.initialize();
		}

		if (isCancelled?.()) return "";

		if (!this.agentSession) {
			throw new Error("Session not initialized");
		}

		// Collect all text blocks for the full response
		const textBlocks: string[] = [];

		// Subscribe to events — send complete text blocks as they finish
		const unsubscribe = this.agentSession.subscribe((event: AgentSessionEvent) => {
			// message_end fires when a complete assistant message is ready
			// (before tool execution, or at the end of the turn)
			if (event.type === "message_end" && event.message.role === "assistant") {
				const msg = event.message;
				// Extract text content (skip thinking, tool calls)
				const text = msg.content
					.filter((c: { type: string }) => c.type === "text")
					.map((c: { type: string; text?: string }) => c.text || "")
					.join("\n")
					.trim();

				if (text) {
					textBlocks.push(text);
					onMessage?.(text);
				}
			}
		});

		try {
			const freshSystemPrompt = buildSystemPromptWithSkills(
				this.config.agentConfig,
				this.config.skillsDir,
			);
			this.agentSession.agent.setSystemPrompt(freshSystemPrompt);

			const now = new Date().toISOString();
			let messagePrefix = `[${now}`;

			const usage = this.agentSession.getContextUsage();
			if (usage && usage.percent !== null) {
				const pct = Math.round(usage.percent);
				messagePrefix += ` | Context: ${pct}%`;
			}
			messagePrefix += "]\n\n";

			await this.agentSession.prompt(messagePrefix + text, images ? { images } : undefined);

			return textBlocks.join("\n\n");
		} finally {
			unsubscribe();
		}
	}

	private async initialize(): Promise<void> {
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
		const sessionManager = SessionManager.open(this.config.sessionFile);

		// Build system prompt from workspace files
		const systemPrompt = buildSystemPromptWithSkills(
			this.config.agentConfig,
			this.config.skillsDir,
		);

		// Create the agent session
		const result = await createAgentSession({
			model,
			sessionManager,
			// No-op resource loader — pion manages its own system prompt and doesn't use
			// pi's extension/skill/theme discovery (which requires npm on PATH)
			resourceLoader: createNoOpResourceLoader(systemPrompt),
			// Custom tools (e.g., Telegram sticker tool)
			customTools: this.config.customTools,
			// TODO: Load skills from agentConfig.skills
		});

		this.agentSession = result.session;
		this.initialized = true;
	}

}
