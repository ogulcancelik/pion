import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeEvent, RuntimeEventBus } from "../../src/core/runtime-events.js";
import { TelegramStatusSink } from "../../src/providers/telegram-status.js";
import type { StatusHandle, StatusUpdate } from "../../src/providers/types.js";

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

type StatusProvider = ConstructorParameters<typeof TelegramStatusSink>[0];
type MessageUpdateRuntimeEvent = Extract<RuntimeEvent, { source: "pi"; type: "message_update" }>;

function makeStatusProvider(overrides: Partial<StatusProvider> = {}): StatusProvider {
	return {
		upsertStatus: async (_status: StatusUpdate) => makeHandle(),
		clearStatus: async (_handle: StatusHandle) => {},
		...overrides,
	};
}

describe("TelegramStatusSink", () => {
	test("creates a status message when processing starts in telegram", async () => {
		const upsertStatus = mock(async (_status: StatusUpdate) => makeHandle());
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

		await sink.handleEvent(makeProcessingStart());

		expect(upsertStatus).toHaveBeenCalledTimes(1);
		expect(upsertStatus).toHaveBeenCalledWith({
			chatId: "chat-1",
			text: expect.stringContaining("⚙️ working"),
			actions: [],
		});
	});

	test("appends compact tool call summaries with tool names and key params", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

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
			text: "⚙️ working\n\n📖 read · `docs/architecture.md`\n📖 read · `src/core/runner.ts`\n⌘ bash · `rg -n runner src`",
			actions: [],
		});
	});

	test("truncates long tool call paths to keep the useful tail in code formatting", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

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
			text: expect.stringContaining("📖 read · `…/with/a/long/name/telegram-status.ts`"),
			actions: [],
		});
	});

	test("shows recall tool query and question params in status bubbles", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-search",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-search",
				toolName: "session_search",
				args: { query: "cloudflare auth callback" },
			},
		});
		await sink.handleEvent({
			id: "evt-query",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-query",
				toolName: "session_query",
				args: {
					sessionPath: "/home/can/.pion/sessions/telegram-contact-123.jsonl",
					question: "what did we decide about auth?",
				},
			},
		});

		expect(upsertStatus.mock.calls[2]?.[0]).toEqual({
			chatId: "chat-1",
			handle,
			text: "⚙️ working\n\n🔎 session search · `cloudflare auth callback`\n🧠 session query · `what did we decide about auth?`",
			actions: [],
		});
	});

	test("hides thinking updates from the rendered status", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

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
				} as unknown as MessageUpdateRuntimeEvent["event"]["message"],
				assistantMessageEvent: {
					type: "text_delta",
					delta: "thinking through it",
					contentIndex: 0,
				} as unknown as MessageUpdateRuntimeEvent["event"]["assistantMessageEvent"],
			} as unknown as MessageUpdateRuntimeEvent["event"],
		});

		expect(upsertStatus).toHaveBeenCalledTimes(1);
	});

	test("keeps tool history when tool execution ends", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
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
			text: "⚙️ working\n\n📖 read · `docs/architecture.md`",
			actions: [],
		});
	});

	test("shows omitted count when tool history exceeds the visible limit", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

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
			text: "⚙️ working\n\n… 2 earlier tool calls\n📖 read · `file-3.ts`\n📖 read · `file-4.ts`\n📖 read · `file-5.ts`\n📖 read · `file-6.ts`\n📖 read · `file-7.ts`\n📖 read · `file-8.ts`\n📖 read · `file-9.ts`\n📖 read · `file-10.ts`\n📖 read · `file-11.ts`\n📖 read · `file-12.ts`",
			actions: [],
		});
	});

	test("clears the status message when processing completes by default", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const clearStatus = mock(async (_handle: StatusHandle) => {});
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus,
			}),
		);

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
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const clearStatus = mock(async (_handle: StatusHandle) => {});
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus,
			}),
		);

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

	test("creates a new status bubble for later tool calls after assistant output is sent", async () => {
		const handles = [
			{ provider: "telegram", chatId: "chat-1", messageId: "42" },
			{ provider: "telegram", chatId: "chat-1", messageId: "43" },
		] as const;
		let nextHandle = 0;
		const upsertStatus = mock(async (status: StatusUpdate) => {
			if (status.handle) {
				return status.handle;
			}
			const handle = handles[nextHandle];
			nextHandle += 1;
			if (!handle) {
				throw new Error("missing status handle");
			}
			return handle;
		});
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
			{ clearOnComplete: false },
		);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-tool-start-1",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "src/first.ts" },
			},
		});
		await sink.handleEvent({
			id: "evt-output",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_output_sent",
			provider: "telegram",
			chatId: "chat-1",
			text: "Let me try a broader search:",
		});
		await sink.handleEvent({
			id: "evt-tool-start-2",
			timestamp: "2026-04-02T21:00:03.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-2",
				toolName: "read",
				args: { path: "src/second.ts" },
			},
		});

		expect(upsertStatus.mock.calls[2]?.[0]).toEqual({
			chatId: "chat-1",
			text: "⚙️ working\n\n📖 read · `src/second.ts`",
			actions: [],
		});
	});

	test("clears all status bubbles from a run when clearOnComplete is enabled", async () => {
		const handles = [
			{ provider: "telegram", chatId: "chat-1", messageId: "42" },
			{ provider: "telegram", chatId: "chat-1", messageId: "43" },
		] as const;
		let nextHandle = 0;
		const upsertStatus = mock(async (status: StatusUpdate) => {
			if (status.handle) {
				return status.handle;
			}
			const handle = handles[nextHandle];
			nextHandle += 1;
			if (!handle) {
				throw new Error("missing status handle");
			}
			return handle;
		});
		const clearStatus = mock(async (_handle: StatusHandle) => {});
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus,
			}),
		);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-tool-start-1",
			timestamp: "2026-04-02T21:00:01.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "src/first.ts" },
			},
		});
		await sink.handleEvent({
			id: "evt-output",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_output_sent",
			provider: "telegram",
			chatId: "chat-1",
			text: "Let me try a broader search:",
		});
		await sink.handleEvent({
			id: "evt-tool-start-2",
			timestamp: "2026-04-02T21:00:03.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-2",
				toolName: "read",
				args: { path: "src/second.ts" },
			},
		});
		await sink.handleEvent({
			id: "evt-complete",
			timestamp: "2026-04-02T21:00:05.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_processing_complete",
			outcome: "completed",
			messagesSent: 2,
			responseLength: 123,
		});

		expect(clearStatus).toHaveBeenCalledTimes(2);
		expect(clearStatus.mock.calls).toEqual([[handles[0]], [handles[1]]]);
	});

	test("keeps all status bubbles from a run when clearOnComplete is disabled", async () => {
		const handles = [
			{ provider: "telegram", chatId: "chat-1", messageId: "42" },
			{ provider: "telegram", chatId: "chat-1", messageId: "43" },
		] as const;
		let nextHandle = 0;
		const upsertStatus = mock(async (status: StatusUpdate) => {
			if (status.handle) {
				return status.handle;
			}
			const handle = handles[nextHandle];
			nextHandle += 1;
			if (!handle) {
				throw new Error("missing status handle");
			}
			return handle;
		});
		const clearStatus = mock(async (_handle: StatusHandle) => {});
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus,
			}),
			{ clearOnComplete: false },
		);

		await sink.handleEvent(makeProcessingStart());
		await sink.handleEvent({
			id: "evt-tool-start-1",
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
			id: "evt-output",
			timestamp: "2026-04-02T21:00:02.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_output_sent",
			provider: "telegram",
			chatId: "chat-1",
			text: "Let me try a broader search:",
		});
		await sink.handleEvent({
			id: "evt-tool-start-2",
			timestamp: "2026-04-02T21:00:03.000Z",
			source: "pi",
			contextKey: "telegram:contact:user-1",
			sessionFile: "/tmp/session.jsonl",
			type: "tool_execution_start",
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-2",
				toolName: "read",
				args: { path: "src/second.ts" },
			},
		});
		await sink.handleEvent({
			id: "evt-complete",
			timestamp: "2026-04-02T21:00:05.000Z",
			source: "pion",
			contextKey: "telegram:contact:user-1",
			type: "runtime_processing_complete",
			outcome: "completed",
			messagesSent: 2,
			responseLength: 123,
		});

		expect(clearStatus).not.toHaveBeenCalled();
		expect(upsertStatus.mock.calls.at(-1)?.[0]).toEqual({
			chatId: "chat-1",
			text: "⚙️ working\n\n📖 read · `src/second.ts`",
			actions: [],
		});
	});

	test("truncates long bash commands from the end instead of the start", async () => {
		const handle = makeHandle();
		const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? handle);
		const sink = new TelegramStatusSink(
			makeStatusProvider({
				upsertStatus,
				clearStatus: mock(async (_handle: StatusHandle) => {}),
			}),
		);

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
			'⌘ bash · `find ~/Projects/pi-mono -type f -name "',
		);
		expect(upsertStatus.mock.calls[1]?.[0]?.text).toContain("…");
	});

	test("can subscribe to the runtime bus and react to emitted events", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pion-telegram-status-"));
		try {
			const upsertStatus = mock(async (status: StatusUpdate) => status.handle ?? makeHandle());
			const clearStatus = mock(async (_handle: StatusHandle) => {});
			const bus = new RuntimeEventBus(dataDir);
			const sink = new TelegramStatusSink(
				makeStatusProvider({
					upsertStatus,
					clearStatus,
				}),
			);

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
