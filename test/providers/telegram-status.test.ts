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

	test("appends compact tool call summaries as emoji-prefixed code lines", async () => {
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
		await sink.handleEvent({
			id: "evt-3",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-2",
				toolName: "read",
				args: { path: "src/core/runner.ts" },
			},
		});
		await sink.handleEvent({
			id: "evt-4",
			timestamp: "2026-04-02T21:00:03.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-3",
				toolName: "bash",
				args: { command: "rg -n runner src" },
			},
		});

		expect(upsertStatus.mock.calls[3]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working\n\n📖 `docs/architecture.md`\n📖 `src/core/runner.ts`\n⌘ `rg -n runner src`",
			actions: [],
		});
	});

	test("truncates long tool call paths to keep the useful tail in code formatting", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-long-path",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-long",
				toolName: "read",
				args: {
					path: "/home/can/Projects/pion/src/providers/some/really/very/deep/nested/file/with/a/long/name/telegram-status.ts",
				},
			},
		});

		expect(upsertStatus.mock.calls[1]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: expect.stringContaining("📖 `…/with/a/long/name/telegram-status.ts`"),
			actions: [],
		});
	});

	test("hides thinking updates from the rendered status", async () => {
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

		expect(upsertStatus).toHaveBeenCalledTimes(1);
	});

	test("keeps tool history when tool execution ends", async () => {
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

		expect(upsertStatus).toHaveBeenCalledTimes(2);
		expect(upsertStatus.mock.calls[1]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working\n\n📖 `docs/architecture.md`",
			actions: [],
		});
	});

	test("shows omitted count when tool history exceeds the visible limit", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		for (let index = 1; index <= 12; index++) {
			await sink.handleEvent({
				id: `evt-${index}`,
				timestamp: `2026-04-02T21:00:${String(index).padStart(2, "0")}.000Z`,
				source: "pi",
				contextKey: "telegram:contact:user-1",
				sessionFile: "/tmp/session.jsonl",
				type: "tool_execution_start",
				event: {
					type: "tool_execution_start",
					toolCallId: `tool-${index}`,
					toolName: "read",
					args: { path: `file-${index}.ts` },
				},
			});
		}

		const latest = upsertStatus.mock.calls.at(-1)?.[0];
		expect(latest).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working\n\n… 2 earlier tool calls\n📖 `file-3.ts`\n📖 `file-4.ts`\n📖 `file-5.ts`\n📖 `file-6.ts`\n📖 `file-7.ts`\n📖 `file-8.ts`\n📖 `file-9.ts`\n📖 `file-10.ts`\n📖 `file-11.ts`\n📖 `file-12.ts`",
			actions: [],
		});
	});

	test("clears the status message when processing completes by default", async () => {
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

	test("keeps the final status message when clearOnComplete is disabled", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const clearStatus = mock(async () => {});
		const sink = new TelegramStatusSink(
			{
				upsertStatus,
				clearStatus,
			} as any,
			{ clearOnComplete: false },
		);

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
				toolName: "bash",
				args: { command: "ls -la ~/Projects/pi-mono" },
			},
		});
		await sink.handleEvent({
			id: "evt-complete",
			timestamp: "2026-04-02T21:00:05.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_processing_complete",
			outcome: "completed",
			messagesSent: 1,
			responseLength: 123,
		});

		expect(clearStatus).not.toHaveBeenCalled();
		expect(upsertStatus.mock.calls.at(-1)?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working\n\n⌘ `ls -la ~/Projects/pi-mono`",
			actions: [],
		});
	});

	test("truncates long bash commands from the end instead of the start", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: any) => status.handle ?? handle);
		const sink = new TelegramStatusSink({
			upsertStatus,
			clearStatus: mock(async () => {}),
		} as any);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-long-command",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-long-command",
				toolName: "bash",
				args: {
					command:
						'find ~/Projects/pi-mono -type f -name ".ts" -o -name ".js" -o -name ".md" -o -name ".json" -o -name ".yaml" -o -name ".yml" | head -15',
				},
			},
		});

		expect(upsertStatus.mock.calls[1]?.[0]?.chatId).toBe("chat-1");
		expect(upsertStatus.mock.calls[1]?.[0]?.handle).toEqual(handle);
		expect(upsertStatus.mock.calls[1]?.[0]?.actions).toEqual([]);
		expect(upsertStatus.mock.calls[1]?.[0]?.text).toContain(
			'⌘ `find ~/Projects/pi-mono -type f -name "',
		);
		expect(upsertStatus.mock.calls[1]?.[0]?.text).toContain("…`");
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
