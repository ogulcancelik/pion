/**
 * Claude engine session — delegates whole turns to Claude Code via the Agent
 * SDK instead of running pi's agent loop.
 *
 * Design points:
 * - Bare system prompt: only the pion workspace prompt (SOUL.md, memory, …)
 *   is sent. Claude Code's heavy preset prompt is deliberately not used.
 * - Session continuity: the SDK session id is persisted into the pion session
 *   mirror file and passed as `resume` on later prompts, so context and
 *   prompt cache survive daemon restarts.
 * - Session mirror: every turn is appended to the same pi-format JSONL file
 *   the pi engine would write, so the monitor TUI, session stats, archiving,
 *   and compaction seeding all work unchanged. Claude Code's own transcript
 *   under ~/.claude remains the canonical conversation.
 * - Pion tools ride an in-process MCP server (see claude-tool-bridge.ts);
 *   Claude Code's built-in WebSearch is disabled in favor of the shared
 *   web-browse skill.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "../config/schema.js";
import { WEB_BROWSE_SKILL_NAME } from "./claude-plugin.js";
import { createPionMcpServer, stripPionToolPrefix } from "./claude-tool-bridge.js";
import { generateSessionHandoff } from "./compactor.js";
import { DEFAULT_SKILLS } from "./default-skills.js";
import type {
	CompactSessionOptions,
	ContextUsageSnapshot,
	RunnerProcessOptions,
} from "./runner.js";
import { UserFacingError, buildTurnPrefix, classifyRuntimeError } from "./runner.js";
import { type RuntimeEventBus, createPiRuntimeEvent } from "./runtime-events.js";
import { buildSystemPrompt, resolveAgentCwd } from "./workspace.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ClaudeSessionConfig {
	agentConfig: AgentConfig;
	contextKey: string;
	/** pi-format mirror session file (same path the pi engine would use). */
	sessionFile: string;
	runtimeEventBus: RuntimeEventBus;
	toolEnv: Record<string, string>;
	/** Pion tools bridged into the session via in-process MCP. */
	customTools: ToolDefinition[];
	/** Shared-skills plugin dir, when available. */
	pluginPath?: string;
}

/** Strip an optional provider prefix: "anthropic/claude-opus-4-8" → "claude-opus-4-8". */
export function claudeModelId(model: string): string | undefined {
	const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	return bare.length > 0 ? bare : undefined;
}

export function claudeThinkingOptions(
	level: ThinkingLevel | undefined,
): Pick<Options, "thinking" | "effort"> {
	if (!level) return {};
	if (level === "off") return { thinking: { type: "disabled" } };
	if (level === "minimal") return { effort: "low" };
	return { effort: level };
}

/**
 * Skills enabled for a claude-engine session: the always-on shared set plus
 * the agent's configured extras — mirroring the pi engine's skill selection.
 */
export function claudeSkillSelection(configured: string[] | undefined): string[] {
	return Array.from(new Set([WEB_BROWSE_SKILL_NAME, ...DEFAULT_SKILLS, ...(configured ?? [])]));
}

interface MirrorState {
	claudeSessionId?: string;
	lastMessageId: string | null;
	/** Seed text (e.g. compaction handoff) to prepend to the first prompt. */
	pendingSeed?: string;
	/** Token total of the last assistant turn recorded in the mirror. */
	lastUsageTokens?: number;
}

/** Loose structural view of Anthropic API content blocks. */
interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

interface UsageBlock {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export class ClaudeSession {
	private config: ClaudeSessionConfig;
	private initialized = false;
	private streaming = false;
	private abortController: AbortController | null = null;
	private mirror: MirrorState = { lastMessageId: null };
	private lastUsageTokens: number | null = null;
	private contextWindow = DEFAULT_CONTEXT_WINDOW;
	/** Tail of the Claude Code subprocess stderr, for error reporting. */
	private stderrTail: string[] = [];
	/** Settles when the in-flight prompt loop has fully stopped. */
	private turnDone: Promise<void> = Promise.resolve();
	private settleTurn: (() => void) | null = null;

	constructor(config: ClaudeSessionConfig) {
		this.config = config;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	getContextUsage(): ContextUsageSnapshot | null {
		if (this.lastUsageTokens === null) return null;
		return {
			tokens: this.lastUsageTokens,
			contextWindow: this.contextWindow,
			percent: (this.lastUsageTokens / this.contextWindow) * 100,
		};
	}

	/** Signal the SDK query to stop, then wait until the prompt loop has exited. */
	async abort(): Promise<void> {
		this.abortController?.abort();
		await this.turnDone;
	}

	async generateHandoff(options: CompactSessionOptions = {}): Promise<string> {
		return generateSessionHandoff(
			(text, promptOptions) => this.prompt(text, undefined, promptOptions),
			options,
		);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.mirror = readMirrorState(this.config.sessionFile);
		if (this.mirror.lastUsageTokens !== undefined) {
			// Restore context accounting across daemon restarts so auto-compaction
			// and context warnings keep working on resumed sessions.
			this.lastUsageTokens = this.mirror.lastUsageTokens;
		}
		this.initialized = true;
	}

	async prompt(
		text: string,
		_images?: Array<{ type: "image"; data: string; mimeType: string }>,
		options: RunnerProcessOptions = {},
	): Promise<string> {
		if (!this.initialized) {
			await this.initialize();
		}
		if (options.isCancelled?.()) return "";

		let promptText = buildTurnPrefix(this.getContextUsage()) + text;
		if (this.mirror.pendingSeed) {
			promptText = `${this.mirror.pendingSeed}\n\n---\n\n${promptText}`;
			this.mirror.pendingSeed = undefined;
		}

		// Surface transcript entries appended by other daemon parts (e.g. cron
		// scheduled deliveries) since our last write: Claude Code resumes from
		// its own transcript, so mirror-only appends are otherwise invisible.
		const externalNotes = this.collectExternalAppends();
		if (externalNotes.length > 0) {
			promptText = `[Runtime note: delivered to this chat while you were idle]\n${externalNotes.join("\n\n")}\n\n---\n\n${promptText}`;
		}

		this.appendMirrorMessage("user", {
			role: "user",
			content: [{ type: "text", text: promptText }],
			timestamp: Date.now(),
		});

		const textBlocks: string[] = [];
		this.stderrTail = [];
		this.abortController = new AbortController();
		this.streaming = true;
		this.turnDone = new Promise((resolve) => {
			this.settleTurn = resolve;
		});

		try {
			const stream = query({
				prompt: promptText,
				options: this.buildQueryOptions(),
			});

			/** toolCallId → display name, for pairing tool_result events. */
			const pendingTools = new Map<string, string>();
			let resultMessage: SDKResultMessage | null = null;

			for await (const message of stream) {
				this.captureSessionId(message);

				if (message.type === "assistant" && message.parent_tool_use_id === null) {
					const blockText = this.handleAssistantMessage(message, pendingTools);
					if (blockText) {
						textBlocks.push(blockText);
						options.onTextBlock?.(blockText);
					}
				} else if (message.type === "user" && message.parent_tool_use_id === null) {
					this.handleToolResults(message, pendingTools);
				} else if (message.type === "result") {
					resultMessage = message;
				}

				if (options.isCancelled?.()) {
					this.abortController.abort();
					break;
				}
			}

			if (resultMessage) {
				this.recordResultUsage(resultMessage);
				if (resultMessage.subtype !== "success") {
					const errors =
						"errors" in resultMessage && resultMessage.errors.length > 0
							? resultMessage.errors.join("; ")
							: resultMessage.subtype;
					throw new Error(`Claude Code run failed: ${errors}`);
				}
			}

			return textBlocks.join("\n\n");
		} catch (error) {
			if (isAbortError(error) || options.isCancelled?.()) {
				return textBlocks.join("\n\n");
			}
			// Fold subprocess stderr into the error: it usually carries the real
			// cause (auth, permission-mode refusal, …) and improves classification.
			const stderrDetail = this.stderrTail.join("").trim();
			const baseMessage = error instanceof Error ? error.message : String(error);
			const errorMessage = stderrDetail ? `${baseMessage}\nstderr: ${stderrDetail}` : baseMessage;
			console.error(`[claude-session] ${this.config.contextKey} failed: ${errorMessage}`);
			const disposition = classifyRuntimeError(new Error(errorMessage));
			if (disposition.kind === "user-facing-fallback") {
				throw new UserFacingError(errorMessage, disposition.userMessage);
			}
			throw error;
		} finally {
			this.streaming = false;
			this.abortController = null;
			this.settleTurn?.();
			this.settleTurn = null;
		}
	}

	/**
	 * Pick up mirror entries written by other components since our last write
	 * (scheduled deliveries carry a `scheduled-` id). Advances the parentId
	 * baseline so our next append chains after them.
	 */
	private collectExternalAppends(): string[] {
		if (!existsSync(this.config.sessionFile)) {
			this.mirror.lastMessageId = null;
			return [];
		}

		const notes: string[] = [];
		let seenBaseline = this.mirror.lastMessageId === null;
		let lastMessageId = this.mirror.lastMessageId;
		for (const entry of readMirrorEntries(this.config.sessionFile)) {
			if (entry.type !== "message" || typeof entry.id !== "string") continue;
			if (seenBaseline && entry.id.startsWith("scheduled-")) {
				const text = joinTextParts(entry.message?.content);
				if (text) notes.push(text);
			}
			if (entry.id === this.mirror.lastMessageId) {
				seenBaseline = true;
			}
			lastMessageId = entry.id;
		}
		this.mirror.lastMessageId = lastMessageId;
		return notes;
	}

	private buildQueryOptions(): Options {
		const agentConfig = this.config.agentConfig;
		const systemPrompt = buildSystemPrompt(agentConfig);

		return {
			model: claudeModelId(agentConfig.model),
			...claudeThinkingOptions(agentConfig.thinkingLevel),
			cwd: resolveAgentCwd(agentConfig),
			resume: this.mirror.claudeSessionId,
			...(systemPrompt.length > 0 ? { systemPrompt } : {}),
			// Isolation: no user/project settings, CLAUDE.md, hooks, or external
			// MCP config. The session is pion's system prompt + tools, like pi.
			settingSources: [],
			strictMcpConfig: true,
			// Pion is an autonomous personal agent; there is no interactive
			// permission prompt on a Telegram bridge.
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			// The shared web-browse skill replaces built-in web search.
			disallowedTools: ["WebSearch"],
			mcpServers: {
				pion: createPionMcpServer(this.config.customTools) as never,
			},
			...(this.config.pluginPath
				? {
						plugins: [{ type: "local" as const, path: this.config.pluginPath }],
						skills: claudeSkillSelection(agentConfig.skills),
					}
				: {}),
			env: { ...process.env, ...this.config.toolEnv },
			abortController: this.abortController ?? undefined,
			stderr: (data) => {
				this.stderrTail.push(data);
				if (this.stderrTail.length > 20) this.stderrTail.shift();
			},
		};
	}

	private captureSessionId(message: SDKMessage): void {
		const sessionId = "session_id" in message ? message.session_id : undefined;
		if (!sessionId || sessionId === this.mirror.claudeSessionId) return;
		this.mirror.claudeSessionId = sessionId;
		this.appendMirrorEntry({
			type: "claude_session",
			sessionId,
			timestamp: new Date().toISOString(),
		});
	}

	/** Mirror + emit events for one top-level assistant message; returns its text. */
	private handleAssistantMessage(
		message: SDKAssistantMessage,
		pendingTools: Map<string, string>,
	): string {
		const blocks = message.message.content as ContentBlock[];
		const usage = (message.message.usage ?? {}) as UsageBlock;

		const parts: Array<Record<string, unknown>> = [];
		const textParts: string[] = [];
		const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];

		for (const block of blocks) {
			if (block.type === "text" && block.text) {
				parts.push({ type: "text", text: block.text });
				textParts.push(block.text);
			} else if (block.type === "thinking" && block.thinking) {
				parts.push({ type: "thinking", thinking: block.thinking });
			} else if (block.type === "tool_use" && block.id && block.name) {
				const displayName = stripPionToolPrefix(block.name);
				parts.push({
					type: "toolCall",
					id: block.id,
					name: displayName,
					arguments: block.input ?? {},
				});
				toolCalls.push({ id: block.id, name: displayName, args: block.input ?? {} });
				pendingTools.set(block.id, displayName);
			}
		}

		const tokens =
			(usage.input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0) +
			(usage.output_tokens ?? 0);
		if (tokens > 0) {
			this.lastUsageTokens = tokens;
		}

		const assistantMessage = {
			role: "assistant",
			content: parts,
			api: "claude-code",
			provider: "claude",
			model: message.message.model,
			usage: {
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheWrite: usage.cache_creation_input_tokens ?? 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		this.appendMirrorMessage("assistant", assistantMessage);
		this.emitPiEvent({ type: "message_end", message: assistantMessage });
		for (const toolCall of toolCalls) {
			this.emitPiEvent({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.args,
			});
		}

		return textParts.join("\n").trim();
	}

	private handleToolResults(message: SDKUserMessage, pendingTools: Map<string, string>): void {
		const content = message.message.content;
		if (!Array.isArray(content)) return;

		for (const block of content as ContentBlock[]) {
			if (block.type !== "tool_result" || !block.tool_use_id) continue;
			const toolName = pendingTools.get(block.tool_use_id);
			if (!toolName) continue;
			pendingTools.delete(block.tool_use_id);
			const resultContent = normalizeToolResultContent(block.content);
			const isError = block.is_error === true;
			// Mirror the result so the monitor's static/replay view can pair it
			// with the toolCall part by toolCallId, like pi sessions.
			this.appendMirrorMessage("toolresult", {
				role: "toolResult",
				toolCallId: block.tool_use_id,
				content: resultContent,
				isError,
				timestamp: Date.now(),
			});
			this.emitPiEvent({
				type: "tool_execution_end",
				toolCallId: block.tool_use_id,
				toolName,
				result: { content: resultContent },
				isError,
			});
		}
	}

	/** Adopt the context window of the turn's dominant model (the main-loop model). */
	private recordResultUsage(result: SDKResultMessage): void {
		let bestTokens = 0;
		for (const usage of Object.values(result.modelUsage)) {
			const tokens =
				usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
			if (tokens >= bestTokens && usage.contextWindow > 0) {
				bestTokens = tokens;
				this.contextWindow = usage.contextWindow;
			}
		}
	}

	private emitPiEvent(event: Record<string, unknown>): void {
		// Synthesized events use the pi AgentSessionEvent schema (source "pi"),
		// so the monitor TUI, runtime inspector, and Telegram status sink treat
		// both engines identically.
		this.config.runtimeEventBus.emit(
			createPiRuntimeEvent(
				this.config.contextKey,
				this.config.sessionFile,
				event as unknown as AgentSessionEvent,
			),
		);
	}

	private appendMirrorMessage(idPrefix: string, message: Record<string, unknown>): void {
		const id = `${idPrefix}-${randomUUID().slice(0, 8)}`;
		this.appendMirrorEntry({
			type: "message",
			id,
			parentId: this.mirror.lastMessageId,
			timestamp: new Date().toISOString(),
			message,
		});
		this.mirror.lastMessageId = id;
	}

	private appendMirrorEntry(entry: Record<string, unknown>): void {
		const sessionFile = this.config.sessionFile;
		if (!existsSync(sessionFile)) {
			mkdirSync(dirname(sessionFile), { recursive: true });
			const header = {
				type: "session",
				version: 3,
				id: `claude-${randomUUID().slice(0, 8)}`,
				timestamp: new Date().toISOString(),
				cwd: resolveAgentCwd(this.config.agentConfig),
				engine: "claude",
			};
			writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
		}
		writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
	}
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
	);
}

function normalizeToolResultContent(content: unknown): Array<{ type: string; text?: string }> {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		return content as Array<{ type: string; text?: string }>;
	}
	return [];
}

/**
 * Read resume/seed state from an existing mirror file.
 *
 * Only mirrors primed by pion (compaction handoff / summary seed — their user
 * message ids start with "summary-") yield a pendingSeed for the fresh Claude
 * session. A mirror that merely lacks a claude_session entry — e.g. a first
 * turn that failed before the SDK emitted a session id — must not replay its
 * stale prompt.
 */
export function readMirrorState(sessionFile: string): MirrorState {
	const state: MirrorState = { lastMessageId: null };

	let seedText: string | undefined;
	for (const entry of readMirrorEntries(sessionFile)) {
		if (entry.type === "claude_session" && entry.sessionId) {
			state.claudeSessionId = entry.sessionId;
		} else if (entry.type === "message" && typeof entry.id === "string") {
			state.lastMessageId = entry.id;
			if (!seedText && entry.id.startsWith("summary-") && entry.message?.role === "user") {
				seedText = joinTextParts(entry.message.content);
			}
			const totalTokens = entry.message?.usage?.totalTokens;
			if (entry.message?.role === "assistant" && totalTokens) {
				state.lastUsageTokens = totalTokens;
			}
		}
	}

	if (!state.claudeSessionId && seedText) {
		state.pendingSeed = seedText;
	}
	return state;
}

interface MirrorEntry {
	type?: string;
	id?: string;
	sessionId?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { totalTokens?: number };
	};
}

function* readMirrorEntries(sessionFile: string): Generator<MirrorEntry> {
	if (!existsSync(sessionFile)) return;
	for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line) as MirrorEntry;
		} catch {
			// Skip malformed lines; the mirror is observability state, not truth.
		}
	}
}

function joinTextParts(content?: Array<{ type?: string; text?: string }>): string | undefined {
	return content
		?.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n");
}
