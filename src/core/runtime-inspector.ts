import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ProviderType } from "../providers/types.js";
import type { RuntimeEvent } from "./runtime-events.js";

export interface RuntimeInspectorToolResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
}

export interface RuntimeInspectorToolSnapshot {
	toolCallId: string;
	toolName: string;
	args: unknown;
	isPartial: boolean;
	isError: boolean;
	partialResult?: RuntimeInspectorToolResult;
	result?: RuntimeInspectorToolResult;
}

export interface RuntimeInspectorCompletionSnapshot {
	timestamp: string;
	outcome: "completed" | "superseded" | "failed";
	messagesSent: number;
	responseLength: number;
	errorMessage?: string;
}

export type RuntimeInspectorStatus = "idle" | "buffered" | "processing" | "superseded" | "failed";

export interface RuntimeInspectorContextSnapshot {
	contextKey: string;
	sessionFile: string;
	sessionName: string;
	agentName?: string;
	provider?: ProviderType;
	chatId?: string;
	status: RuntimeInspectorStatus;
	live: boolean;
	pendingMessageCount: number;
	lastEventAt?: string;
	lastActiveAt?: string;
	lastMessagePreview?: string;
	queue: {
		steering: string[];
		followUp: string[];
	};
	lastSupersededReason?: "new_message" | "stop" | "new" | "compact" | "restart";
	lastWarning?: string;
	lastCompletion?: RuntimeInspectorCompletionSnapshot;
	currentAssistantMessage?: AssistantMessage;
	activeTools: RuntimeInspectorToolSnapshot[];
}

export interface RuntimeInspectorSnapshot {
	version: 1;
	updatedAt: string;
	contexts: RuntimeInspectorContextSnapshot[];
}

export interface RuntimeInspectorContextRegistration {
	agentName: string;
	contextKey: string;
	provider?: ProviderType;
	chatId?: string;
}

type RuntimeInspectorListener = (snapshot: RuntimeInspectorSnapshot) => void;

function nowIso(): string {
	return new Date().toISOString();
}

function defaultSnapshot(): RuntimeInspectorSnapshot {
	return {
		version: 1,
		updatedAt: nowIso(),
		contexts: [],
	};
}

function sanitizeContextKey(contextKey: string): string {
	return contextKey.replace(/[:/\\]/g, "-");
}

export function runtimeInspectorStateFileFor(dataDir: string): string {
	return join(dataDir, "runtime", "inspector-state.json");
}

export function runtimeInspectorSocketFileFor(dataDir: string): string {
	return join(dataDir, "runtime", "inspector.sock");
}

export function sessionFileForContext(dataDir: string, contextKey: string): string {
	return join(dataDir, "sessions", `${sanitizeContextKey(contextKey)}.jsonl`);
}

function sessionNameForFile(sessionFile: string): string {
	return (
		sessionFile
			.split("/")
			.pop()
			?.replace(/\.jsonl$/, "") ?? "session"
	);
}

function isPiEvent(event: RuntimeEvent): event is Extract<RuntimeEvent, { source: "pi" }> {
	return event.source === "pi";
}

function isPionEvent(event: RuntimeEvent): event is Extract<RuntimeEvent, { source: "pion" }> {
	return event.source === "pion";
}

export class RuntimeInspectorStore {
	private contexts = new Map<string, RuntimeInspectorContextSnapshot>();
	private listeners = new Set<RuntimeInspectorListener>();
	private stateFile: string;

	constructor(private dataDir: string) {
		this.stateFile = runtimeInspectorStateFileFor(dataDir);
		for (const context of this.readSnapshot().contexts) {
			this.contexts.set(context.contextKey, context);
		}
	}

	registerContext(registration: RuntimeInspectorContextRegistration): void {
		const context = this.getOrCreateContext(registration.contextKey);
		context.agentName = registration.agentName;
		context.provider = registration.provider ?? context.provider;
		context.chatId = registration.chatId ?? context.chatId;
		context.lastEventAt = nowIso();
		context.lastActiveAt = context.lastActiveAt ?? context.lastEventAt;
		this.commit(true);
	}

	subscribe(listener: RuntimeInspectorListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): RuntimeInspectorSnapshot {
		return {
			version: 1,
			updatedAt: nowIso(),
			contexts: Array.from(this.contexts.values()).sort((a, b) => {
				const aTime = a.lastActiveAt ?? a.lastEventAt ?? "";
				const bTime = b.lastActiveAt ?? b.lastEventAt ?? "";
				return bTime.localeCompare(aTime);
			}),
		};
	}

	handleRuntimeEvent(event: RuntimeEvent): void {
		const context = this.getOrCreateContext(event.contextKey);
		context.lastEventAt = event.timestamp;
		context.lastActiveAt = event.timestamp;

		if (isPionEvent(event)) {
			this.handlePionEvent(context, event);
			this.commit(event.type !== "runtime_output_sent");
			return;
		}

		this.handlePiEvent(context, event);
		this.commit(event.type !== "message_update" && event.type !== "tool_execution_update");
	}

	private handlePionEvent(
		context: RuntimeInspectorContextSnapshot,
		event: Extract<RuntimeEvent, { source: "pion" }>,
	): void {
		switch (event.type) {
			case "runtime_message_received":
				context.provider = event.provider;
				context.chatId = event.chatId;
				context.lastMessagePreview = event.text;
				break;
			case "runtime_message_buffered":
				context.pendingMessageCount = event.messageCount;
				context.status = "buffered";
				context.live = true;
				break;
			case "runtime_messages_merged":
				context.pendingMessageCount = 0;
				break;
			case "runtime_processing_start":
				context.agentName = event.agentName;
				context.provider = event.provider;
				context.chatId = event.chatId;
				context.status = "processing";
				context.live = true;
				context.pendingMessageCount = 0;
				context.currentAssistantMessage = undefined;
				context.activeTools = [];
				break;
			case "runtime_superseded":
				context.lastSupersededReason = event.reason;
				if (context.status !== "processing") {
					context.status = "superseded";
				}
				context.live = true;
				break;
			case "runtime_warning_emitted":
				context.lastWarning = event.warning;
				break;
			case "runtime_output_sent":
				break;
			case "runtime_processing_complete":
				context.lastCompletion = {
					timestamp: event.timestamp,
					outcome: event.outcome,
					messagesSent: event.messagesSent,
					responseLength: event.responseLength,
					errorMessage: event.errorMessage,
				};
				context.pendingMessageCount = 0;
				context.live = false;
				context.currentAssistantMessage = undefined;
				context.activeTools = [];
				context.queue = { steering: [], followUp: [] };
				context.status =
					event.outcome === "failed"
						? "failed"
						: event.outcome === "superseded"
							? "superseded"
							: "idle";
				break;
		}
	}

	private handlePiEvent(
		context: RuntimeInspectorContextSnapshot,
		event: Extract<RuntimeEvent, { source: "pi" }>,
	): void {
		switch (event.type) {
			case "queue_update": {
				const queueEvent = event.event as {
					steering: readonly string[];
					followUp: readonly string[];
				};
				context.queue = {
					steering: [...queueEvent.steering],
					followUp: [...queueEvent.followUp],
				};
				context.live = true;
				break;
			}
			case "message_start":
			case "message_update":
			case "message_end": {
				const messageEvent = event.event as { message: { role: string } };
				if (messageEvent.message.role === "assistant") {
					context.currentAssistantMessage = messageEvent.message as AssistantMessage;
					context.status = "processing";
					context.live = true;
				}
				break;
			}
			case "tool_execution_start": {
				const toolEvent = event.event as { toolCallId: string; toolName: string; args: unknown };
				const tool = this.getOrCreateTool(context, toolEvent.toolCallId, toolEvent.toolName);
				tool.args = toolEvent.args;
				tool.isPartial = true;
				tool.isError = false;
				context.status = "processing";
				context.live = true;
				break;
			}
			case "tool_execution_update": {
				const toolEvent = event.event as {
					toolCallId: string;
					toolName: string;
					args: unknown;
					partialResult: unknown;
				};
				const tool = this.getOrCreateTool(context, toolEvent.toolCallId, toolEvent.toolName);
				tool.args = toolEvent.args;
				tool.partialResult = normalizeToolResult(toolEvent.partialResult, false);
				tool.isPartial = true;
				break;
			}
			case "tool_execution_end": {
				const toolEvent = event.event as {
					toolCallId: string;
					toolName: string;
					result: unknown;
					isError: boolean;
				};
				const tool = this.getOrCreateTool(context, toolEvent.toolCallId, toolEvent.toolName);
				tool.result = normalizeToolResult(toolEvent.result, toolEvent.isError);
				tool.isPartial = false;
				tool.isError = toolEvent.isError;
				break;
			}
			default:
				break;
		}
	}

	private getOrCreateContext(contextKey: string): RuntimeInspectorContextSnapshot {
		let context = this.contexts.get(contextKey);
		if (context) return context;

		const sessionFile = sessionFileForContext(this.dataDir, contextKey);
		context = {
			contextKey,
			sessionFile,
			sessionName: sessionNameForFile(sessionFile),
			status: "idle",
			live: false,
			pendingMessageCount: 0,
			queue: { steering: [], followUp: [] },
			activeTools: [],
		};
		this.contexts.set(contextKey, context);
		return context;
	}

	private getOrCreateTool(
		context: RuntimeInspectorContextSnapshot,
		toolCallId: string,
		toolName: string,
	): RuntimeInspectorToolSnapshot {
		let tool = context.activeTools.find((entry) => entry.toolCallId === toolCallId);
		if (tool) return tool;

		tool = {
			toolCallId,
			toolName,
			args: {},
			isPartial: true,
			isError: false,
		};
		context.activeTools.push(tool);
		return tool;
	}

	private commit(persist: boolean): void {
		const snapshot = this.getSnapshot();
		if (persist) {
			this.writeSnapshot(snapshot);
		}
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	private readSnapshot(): RuntimeInspectorSnapshot {
		if (!existsSync(this.stateFile)) {
			return defaultSnapshot();
		}

		try {
			return JSON.parse(readFileSync(this.stateFile, "utf-8")) as RuntimeInspectorSnapshot;
		} catch {
			return defaultSnapshot();
		}
	}

	private writeSnapshot(snapshot: RuntimeInspectorSnapshot): void {
		mkdirSync(join(this.dataDir, "runtime"), { recursive: true });
		writeFileSync(this.stateFile, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf-8");
	}
}

function normalizeToolResult(result: unknown, isError: boolean): RuntimeInspectorToolResult {
	if (
		result &&
		typeof result === "object" &&
		Array.isArray((result as { content?: unknown }).content)
	) {
		const value = result as {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		};
		return {
			content: value.content,
			details: value.details,
			isError: value.isError ?? isError,
		};
	}

	return {
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		isError,
	};
}
