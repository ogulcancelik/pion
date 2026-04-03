import type { RuntimeEvent, RuntimeEventBus } from "../core/runtime-events.js";
import type { StatusHandle, StatusUpdate } from "./types.js";

interface TelegramStatusProvider {
	upsertStatus(status: StatusUpdate): Promise<StatusHandle>;
	clearStatus(handle: StatusHandle): Promise<void>;
}

interface TelegramStatusSinkOptions {
	clearOnComplete?: boolean;
}

interface TelegramStatusState {
	chatId: string;
	handle?: StatusHandle;
	statusLine: string;
	toolLines: string[];
	lastRenderedText?: string;
	sealedAfterAssistantOutput: boolean;
	handlesSeen: StatusHandle[];
}

const MAX_VISIBLE_TOOL_LINES = 10;

function renderStatusText(state: TelegramStatusState): string {
	const lines = [state.statusLine];
	if (state.toolLines.length > 0) {
		const omittedCount = Math.max(0, state.toolLines.length - MAX_VISIBLE_TOOL_LINES);
		const visibleToolLines = state.toolLines.slice(-MAX_VISIBLE_TOOL_LINES);
		lines.push("");
		if (omittedCount > 0) {
			lines.push(`… ${omittedCount} earlier tool call${omittedCount === 1 ? "" : "s"}`);
		}
		lines.push(...visibleToolLines);
	}
	return lines.join("\n");
}

function truncateTail(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	return `…/${value.split("/").filter(Boolean).slice(-5).join("/")}`;
}

function truncateEnd(value: string, maxLength = 40): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function codeSpan(value: string): string {
	const backtickRuns = value.match(/`+/g) ?? [];
	const delimiterLength = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0) + 1;
	const delimiter = "`".repeat(delimiterLength);
	return `${delimiter}${value}${delimiter}`;
}

function toolLabel(toolName: string): string {
	return toolName.replaceAll("_", " ");
}

function toolIcon(toolName: string): string {
	if (toolName === "read") return "📖";
	if (toolName === "bash") return "⌘";
	if (toolName === "session_search") return "🔎";
	if (toolName === "session_query") return "🧠";
	return "•";
}

function formatStatusToolLine(toolName: string, value?: string): string {
	return value
		? `${toolIcon(toolName)} ${toolLabel(toolName)} · ${codeSpan(value)}`
		: `${toolIcon(toolName)} ${toolLabel(toolName)}`;
}

type ToolStatusSummarizer = (toolName: string, args: Record<string, unknown>) => string | undefined;

const TOOL_STATUS_SUMMARIZERS: Record<string, ToolStatusSummarizer> = {
	read: (toolName, args) =>
		typeof args.path === "string"
			? formatStatusToolLine(toolName, truncateTail(args.path))
			: undefined,
	bash: (toolName, args) =>
		typeof args.command === "string"
			? formatStatusToolLine(toolName, truncateEnd(args.command, 40))
			: undefined,
	session_search: (toolName, args) =>
		typeof args.query === "string"
			? formatStatusToolLine(toolName, truncateEnd(args.query, 44))
			: undefined,
	session_query: (toolName, args) =>
		typeof args.question === "string"
			? formatStatusToolLine(toolName, truncateEnd(args.question, 44))
			: undefined,
};

function summarizeToolCall(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const value = args as Record<string, unknown>;
		const customSummary = TOOL_STATUS_SUMMARIZERS[toolName]?.(toolName, value);
		if (customSummary) {
			return customSummary;
		}
		if (typeof value.path === "string") {
			return formatStatusToolLine(toolName, truncateTail(value.path));
		}
		if (typeof value.command === "string") {
			return formatStatusToolLine(toolName, truncateEnd(value.command, 40));
		}
		if (typeof value.query === "string") {
			return formatStatusToolLine(toolName, truncateEnd(value.query, 44));
		}
		if (typeof value.question === "string") {
			return formatStatusToolLine(toolName, truncateEnd(value.question, 44));
		}
	}
	return toolLabel(toolName);
}

export class TelegramStatusSink {
	private states = new Map<string, TelegramStatusState>();
	private eventQueue: Promise<void> = Promise.resolve();
	private options: Required<TelegramStatusSinkOptions>;

	constructor(
		private provider: TelegramStatusProvider,
		options: TelegramStatusSinkOptions = {},
	) {
		this.options = {
			clearOnComplete: options.clearOnComplete ?? true,
		};
	}

	attach(bus: RuntimeEventBus): () => void {
		return bus.subscribe((event) => {
			this.eventQueue = this.eventQueue.then(() => this.handleEvent(event));
		});
	}

	private async pushStatus(state: TelegramStatusState): Promise<void> {
		const text = renderStatusText(state);
		if (state.lastRenderedText === text && state.handle) {
			return;
		}
		state.handle = await this.provider.upsertStatus({
			chatId: state.chatId,
			handle: state.handle,
			text,
			actions: [],
		});
		state.lastRenderedText = text;
		this.recordHandle(state, state.handle);
	}

	private recordHandle(state: TelegramStatusState, handle: StatusHandle | undefined): void {
		if (!handle) return;
		const alreadySeen = state.handlesSeen.some(
			(existing) =>
				existing.provider === handle.provider &&
				existing.chatId === handle.chatId &&
				existing.messageId === handle.messageId,
		);
		if (!alreadySeen) {
			state.handlesSeen.push(handle);
		}
	}

	private startFreshToolPhase(state: TelegramStatusState): void {
		state.handle = undefined;
		state.toolLines = [];
		state.lastRenderedText = undefined;
		state.sealedAfterAssistantOutput = false;
	}

	whenIdle(): Promise<void> {
		return this.eventQueue;
	}

	async handleEvent(event: RuntimeEvent): Promise<void> {
		if (event.source === "pion") {
			await this.handlePionEvent(event);
			return;
		}

		await this.handlePiEvent(event);
	}

	private async handlePionEvent(event: Extract<RuntimeEvent, { source: "pion" }>): Promise<void> {
		if (event.type === "runtime_processing_start") {
			if (event.provider !== "telegram") return;

			const state: TelegramStatusState = {
				chatId: event.chatId,
				statusLine: "⚙️ working",
				toolLines: [],
				sealedAfterAssistantOutput: false,
				handlesSeen: [],
			};
			await this.pushStatus(state);
			this.states.set(event.contextKey, state);
			return;
		}

		if (event.type === "runtime_output_sent") {
			if (event.provider !== "telegram") return;
			const state = this.states.get(event.contextKey);
			if (!state) return;
			state.sealedAfterAssistantOutput = true;
			return;
		}

		if (event.type === "runtime_processing_complete") {
			const state = this.states.get(event.contextKey);
			if (!state) return;
			if (event.outcome === "failed" && state.handle) {
				state.statusLine = `⚠️ failed${event.errorMessage ? ` — ${event.errorMessage}` : ""}`;
				await this.pushStatus(state);
			}
			if (this.options.clearOnComplete) {
				for (const handle of state.handlesSeen) {
					await this.provider.clearStatus(handle);
				}
			}
			this.states.delete(event.contextKey);
		}
	}

	private async handlePiEvent(event: Extract<RuntimeEvent, { source: "pi" }>): Promise<void> {
		const state = this.states.get(event.contextKey);
		if (!state) return;

		if (event.type === "message_update") {
			return;
		}

		if (event.type === "tool_execution_start") {
			if (state.sealedAfterAssistantOutput) {
				this.startFreshToolPhase(state);
			}
			const toolEvent = event.event as { toolName: string; args?: unknown };
			state.toolLines.push(summarizeToolCall(toolEvent.toolName, toolEvent.args));
			await this.pushStatus(state);
			return;
		}

		if (event.type === "tool_execution_end") {
			return;
		}
	}
}
