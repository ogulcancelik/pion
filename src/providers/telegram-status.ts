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

function summarizeToolCall(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const value = args as Record<string, unknown>;
		if (toolName === "read" && typeof value.path === "string") {
			return `📖 ${codeSpan(truncateTail(value.path))}`;
		}
		if (toolName === "bash" && typeof value.command === "string") {
			return `⌘ ${codeSpan(truncateEnd(value.command, 40))}`;
		}
	}
	const icon = toolName === "read" ? "📖" : toolName === "bash" ? "⌘" : "•";
	return `${icon} ${codeSpan(toolName)}`;
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
			};
			await this.pushStatus(state);
			this.states.set(event.contextKey, state);
			return;
		}

		if (event.type === "runtime_processing_complete") {
			const state = this.states.get(event.contextKey);
			if (!state?.handle) return;
			if (event.outcome === "failed") {
				state.statusLine = `⚠️ failed${event.errorMessage ? ` — ${event.errorMessage}` : ""}`;
				await this.pushStatus(state);
			}
			if (this.options.clearOnComplete) {
				await this.provider.clearStatus(state.handle);
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
