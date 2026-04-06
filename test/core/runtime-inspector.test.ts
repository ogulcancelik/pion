import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "../../src/core/runtime-events.js";
import { RuntimeInspectorStore } from "../../src/core/runtime-inspector.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pion-runtime-inspector-"));
}

function makeProcessingStart(): RuntimeEvent {
	return {
		id: "evt-processing-start",
		timestamp: "2026-04-06T12:00:00.000Z",
		source: "pion",
		contextKey: "telegram:contact:user-1",
		type: "runtime_processing_start",
		agentName: "main",
		provider: "telegram",
		chatId: "chat-1",
		messageId: "msg-1",
	};
}

describe("RuntimeInspectorStore", () => {
	test("tracks buffered and active runtime state for a context", () => {
		const dataDir = makeTempDir();
		try {
			const store = new RuntimeInspectorStore(dataDir);
			store.registerContext({
				agentName: "main",
				contextKey: "telegram:contact:user-1",
				provider: "telegram",
				chatId: "chat-1",
			});

			store.handleRuntimeEvent({
				id: "evt-message-received",
				timestamp: "2026-04-06T11:59:58.000Z",
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_message_received",
				provider: "telegram",
				chatId: "chat-1",
				messageId: "msg-1",
				senderId: "user-1",
				isGroup: false,
				text: "hello from telegram",
				mediaCount: 0,
			});
			store.handleRuntimeEvent({
				id: "evt-buffered",
				timestamp: "2026-04-06T11:59:59.000Z",
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_message_buffered",
				messageCount: 2,
			});

			let snapshot = store.getSnapshot();
			expect(snapshot.contexts).toHaveLength(1);
			expect(snapshot.contexts[0]).toMatchObject({
				agentName: "main",
				contextKey: "telegram:contact:user-1",
				status: "buffered",
				live: true,
				pendingMessageCount: 2,
				lastMessagePreview: "hello from telegram",
			});
			expect(snapshot.contexts[0]?.sessionFile).toBe(
				join(dataDir, "sessions", "telegram-contact-user-1.jsonl"),
			);

			store.handleRuntimeEvent(makeProcessingStart());
			store.handleRuntimeEvent({
				id: "evt-message-update",
				timestamp: "2026-04-06T12:00:01.000Z",
				source: "pi",
				contextKey: "telegram:contact:user-1",
				sessionFile: join(dataDir, "sessions", "telegram-contact-user-1.jsonl"),
				type: "message_update",
				event: {
					type: "message_update",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Working on it" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet",
						usage: { input: 1, output: 1, totalTokens: 2 },
						stopReason: "streaming",
						timestamp: Date.now(),
					},
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "Working on it",
					},
				},
			} as unknown as RuntimeEvent);
			store.handleRuntimeEvent({
				id: "evt-tool-start",
				timestamp: "2026-04-06T12:00:02.000Z",
				source: "pi",
				contextKey: "telegram:contact:user-1",
				sessionFile: join(dataDir, "sessions", "telegram-contact-user-1.jsonl"),
				type: "tool_execution_start",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "read",
					args: { path: "docs/runtime.md" },
				},
			} as unknown as RuntimeEvent);
			store.handleRuntimeEvent({
				id: "evt-tool-update",
				timestamp: "2026-04-06T12:00:03.000Z",
				source: "pi",
				contextKey: "telegram:contact:user-1",
				sessionFile: join(dataDir, "sessions", "telegram-contact-user-1.jsonl"),
				type: "tool_execution_update",
				event: {
					type: "tool_execution_update",
					toolCallId: "tool-1",
					toolName: "read",
					args: { path: "docs/runtime.md" },
					partialResult: {
						content: [{ type: "text", text: "partial output" }],
						isError: false,
					},
				},
			} as unknown as RuntimeEvent);
			store.handleRuntimeEvent({
				id: "evt-tool-end",
				timestamp: "2026-04-06T12:00:04.000Z",
				source: "pi",
				contextKey: "telegram:contact:user-1",
				sessionFile: join(dataDir, "sessions", "telegram-contact-user-1.jsonl"),
				type: "tool_execution_end",
				event: {
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "read",
					result: {
						content: [{ type: "text", text: "final output" }],
						isError: false,
					},
					isError: false,
				},
			} as unknown as RuntimeEvent);

			snapshot = store.getSnapshot();
			expect(snapshot.contexts[0]).toMatchObject({
				status: "processing",
				live: true,
				pendingMessageCount: 0,
				currentAssistantMessage: {
					role: "assistant",
					content: [{ type: "text", text: "Working on it" }],
				},
			});
			expect(snapshot.contexts[0]?.activeTools).toEqual([
				{
					toolCallId: "tool-1",
					toolName: "read",
					args: { path: "docs/runtime.md" },
					isPartial: false,
					isError: false,
					result: {
						content: [{ type: "text", text: "final output" }],
						isError: false,
					},
					partialResult: {
						content: [{ type: "text", text: "partial output" }],
						isError: false,
					},
				},
			]);

			store.handleRuntimeEvent({
				id: "evt-complete",
				timestamp: "2026-04-06T12:00:05.000Z",
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 24,
			});

			snapshot = store.getSnapshot();
			expect(snapshot.contexts[0]).toMatchObject({
				status: "idle",
				live: false,
				pendingMessageCount: 0,
				currentAssistantMessage: undefined,
				activeTools: [],
				lastCompletion: {
					outcome: "completed",
					messagesSent: 1,
					responseLength: 24,
					timestamp: "2026-04-06T12:00:05.000Z",
				},
			});
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("reloads persisted context metadata for offline monitor selection", () => {
		const dataDir = makeTempDir();
		try {
			const store = new RuntimeInspectorStore(dataDir);
			store.registerContext({
				agentName: "main",
				contextKey: "telegram:contact:user-2",
				provider: "telegram",
				chatId: "chat-2",
			});
			store.handleRuntimeEvent({
				id: "evt-complete",
				timestamp: "2026-04-06T13:00:00.000Z",
				source: "pion",
				contextKey: "telegram:contact:user-2",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 10,
			});

			const reloaded = new RuntimeInspectorStore(dataDir);
			const snapshot = reloaded.getSnapshot();

			expect(snapshot.contexts).toHaveLength(1);
			expect(snapshot.contexts[0]).toMatchObject({
				agentName: "main",
				contextKey: "telegram:contact:user-2",
				status: "idle",
				lastCompletion: {
					outcome: "completed",
				},
			});
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
