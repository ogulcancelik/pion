import type { RuntimeEvent, RuntimeEventBus } from "../core/runtime-events.js";
import type { StatusHandle, StatusUpdate } from "./types.js";

interface TelegramStatusProvider {
	upsertStatus(status: StatusUpdate): Promise<StatusHandle>;
	clearStatus(handle: StatusHandle): Promise<void>;
}

interface TelegramStatusState {
	chatId: string;
	handle?: StatusHandle;
	statusLine: string;
	detailLine?: string;
	toolLine?: string;
}

function renderStatusText(state: TelegramStatusState): string {
	return [state.statusLine, state.detailLine, state.toolLine].filter(Boolean).join("\n\n");
}

export class TelegramStatusSink {
	private states = new Map<string, TelegramStatusState>();
	private eventQueue: Promise<void> = Promise.resolve();

	constructor(private provider: TelegramStatusProvider) {}

	attach(bus: RuntimeEventBus): () => void {
		return bus.subscribe((event) => {
			this.eventQueue = this.eventQueue.then(() => this.handleEvent(event));
		});
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
			};
			state.handle = await this.provider.upsertStatus({
				chatId: state.chatId,
				text: renderStatusText(state),
				actions: [],
			});
			this.states.set(event.contextKey, state);
			return;
		}

		if (event.type === "runtime_processing_complete") {
			const state = this.states.get(event.contextKey);
			if (!state?.handle) return;
			if (event.outcome === "failed") {
				state.statusLine = "⚠️ failed";
				state.detailLine = event.errorMessage ? `error: ${event.errorMessage}` : undefined;
				state.toolLine = undefined;
				state.handle = await this.provider.upsertStatus({
					chatId: state.chatId,
					handle: state.handle,
					text: renderStatusText(state),
					actions: [],
				});
			}
			await this.provider.clearStatus(state.handle);
			this.states.delete(event.contextKey);
		}
	}

	private async handlePiEvent(event: Extract<RuntimeEvent, { source: "pi" }>): Promise<void> {
		const state = this.states.get(event.contextKey);
		if (!state) return;

		if (event.type === "message_update") {
			state.detailLine = "thinking…";
			state.handle = await this.provider.upsertStatus({
				chatId: state.chatId,
				handle: state.handle,
				text: renderStatusText(state),
				actions: [],
			});
			return;
		}

		if (event.type === "tool_execution_start") {
			state.detailLine = undefined;
			state.toolLine = `• ${(event.event as { toolName: string }).toolName}`;
			state.handle = await this.provider.upsertStatus({
				chatId: state.chatId,
				handle: state.handle,
				text: renderStatusText(state),
				actions: [],
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			state.toolLine = undefined;
			state.handle = await this.provider.upsertStatus({
				chatId: state.chatId,
				handle: state.handle,
				text: renderStatusText(state),
				actions: [],
			});
		}
	}
}
