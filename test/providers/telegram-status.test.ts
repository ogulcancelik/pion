import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventBus, type RuntimeEvent } from "../../src/core/runtime-events.js";
import type { StatusHandle } from "../../src/providers/types.js";
import { TelegramStatusSink } from "../../src/providers/telegram-status.js";

function makeHandle(): StatusHandle {
	return {
		provider: "telegram",
		chatId: "chat-1",
		messageId: "42",
	};
}

function makeProcessingStart(): RuntimeEvent {
	return {
		id: "evt-1",
		timestamp: "2026-04-02T21:00:00.000Z",
		source: "pion",
		contextKey: "telegram:contact:user-1",
		type: "runtime_processing_start",
		agentName: "main",
		provider: "telegram",
		chatId: "chat-1",
		messageId: "msg-1",
	};
}

describe("TelegramStatusSink", () => {
	test("creates a status message when processing starts in telegram", async () => {
		const upsertStatus = mock(async () => makeHandle());
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());

		expect(upsertStatus).toHaveBeenCalledTimes(1);
		expect(upsertStatus).toHaveBeenCalledWith({
			chatId: "chat-1",
			text: expect.stringContaining("⚙️ working"),
			actions: [],
		});
	});

	test("updates the same status message when tool execution events arrive", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-2",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "docs/architecture.md" },
			},
		});

		expect(upsertStatus).toHaveBeenCalledTimes(2);
		expect(upsertStatus.mock.calls[1]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: expect.stringContaining("read"),
			actions: [],
		});
	});

	test("clears the status message when processing completes", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const clearStatus = mock(async () => {});
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus,
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-3",
			timestamp: "2026-04-02T21:00:05.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_processing_complete",
			outcome: "completed",
			messagesSent: 1,
			responseLength: 123,
		});

		expect(clearStatus).toHaveBeenCalledTimes(1);
		expect(clearStatus).toHaveBeenCalledWith(handle);
	});

	test("shows thinking state on assistant message updates", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-thinking",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "message_update",
			event: {
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "thinking through it" }],
				} as any,
				assistantMessageEvent: { type: "text_delta", delta: "thinking through it", contentIndex: 0 } as any,
			},
		});

		expect(upsertStatus.mock.calls[1]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: expect.stringContaining("thinking…"),
			actions: [],
		});
	});

	test("removes the active tool line when tool execution ends", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-tool-start",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "docs/architecture.md" },
			},
		});
		await sink.handleEvent({
			id: "evt-tool-end",
			timestamp: "2026-04-02T21:00:03.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_end",
			event: {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "ok" }], isError: false },
				isError: false,
			},
		});

		expect(upsertStatus.mock.calls[2]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working",
			actions: [],
		});
	});

	test("shows a failure state before clearing on failed completion", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const clearStatus = mock(async () => {});
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus,
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-failed",
			timestamp: "2026-04-02T21:00:05.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_processing_complete",
			outcome: "failed",
			messagesSent: 1,
			responseLength: 12,
			errorMessage: "network timeout",
		});

		expect(upsertStatus.mock.calls[1]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: expect.stringContaining("failed"),
			actions: [],
		});
		expect(clearStatus).toHaveBeenCalledTimes(1);
	});

	test("ignores non-telegram runtime events", async () => {
		const upsertStatus = mock(async () => makeHandle());
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent({
			id: "evt-4",
			timestamp: "2026-04-02T21:00:00.000Z",
			source: "pion",
			contextKey: "whatsapp:contact:user-1",
			type: "runtime_processing_start",
			agentName: "main",
			provider: "whatsapp",
			chatId: "chat-2",
			messageId: "msg-2",
		});

		expect(upsertStatus).not.toHaveBeenCalled();
	});

	test("can subscribe to the runtime bus and react to emitted events", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pion-telegram-status-"));
		try {
			const upsertStatus = mock(async (status: any) => status.handle ?? makeHandle());
			const clearStatus = mock(async () => {});
			const bus = new RuntimeEventBus(dataDir);
			const sink = new TelegramStatusSink({
				upsertStatus,
				clearStatus,
			} as any);

			const unsubscribe = sink.attach(bus);
			bus.emit({
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_processing_start",
				agentName: "main",
				provider: "telegram",
				chatId: "chat-1",
				messageId: "msg-1",
			});
			bus.emit({
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 5,
			});
			await sink.whenIdle();

			expect(upsertStatus).toHaveBeenCalledTimes(1);
			expect(clearStatus).toHaveBeenCalledTimes(1);
			unsubscribe();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
