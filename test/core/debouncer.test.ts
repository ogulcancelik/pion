import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MessageDebouncer, mergeMessages } from "../../src/core/debouncer.js";
import type { Message } from "../../src/providers/types.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg-1",
		chatId: "chat-1",
		senderId: "user-1",
		senderName: "Test User",
		text: "hello",
		isGroup: false,
		provider: "telegram",
		timestamp: new Date("2026-03-21T10:00:00Z"),
		raw: {},
		...overrides,
	};
}

describe("MessageDebouncer", () => {
	let debouncer: MessageDebouncer;
	let flushed: { contextKey: string; messages: Message[] }[];

	beforeEach(() => {
		flushed = [];
	});

	afterEach(() => {
		debouncer?.dispose();
	});

	describe("single message", () => {
		test("flushes after timeout", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			const msg = makeMessage({ text: "hello" });
			debouncer.add("ctx-1", msg);

			// Not flushed yet
			expect(flushed).toHaveLength(0);

			// Wait for timeout
			await Bun.sleep(80);

			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.contextKey).toBe("ctx-1");
			expect(flushed[0]!.messages).toHaveLength(1);
			expect(flushed[0]!.messages[0]!.text).toBe("hello");
		});

		test("does not flush before timeout", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 100,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage());

			await Bun.sleep(50);
			expect(flushed).toHaveLength(0);
		});
	});

	describe("batching multiple messages", () => {
		test("batches messages within timeout window", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 80,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ id: "1", text: "hello" }));
			await Bun.sleep(30);
			debouncer.add("ctx-1", makeMessage({ id: "2", text: "world" }));
			await Bun.sleep(30);
			debouncer.add("ctx-1", makeMessage({ id: "3", text: "!" }));

			// Timer was reset twice, so nothing flushed yet
			expect(flushed).toHaveLength(0);

			// Wait for final timeout
			await Bun.sleep(100);

			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.messages).toHaveLength(3);
			expect(flushed[0]!.messages.map((m) => m.text)).toEqual(["hello", "world", "!"]);
		});

		test("resets timer on each new message", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 60,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			// Send messages every 40ms — each resets the 60ms timer
			debouncer.add("ctx-1", makeMessage({ id: "1", text: "a" }));
			await Bun.sleep(40);
			debouncer.add("ctx-1", makeMessage({ id: "2", text: "b" }));
			await Bun.sleep(40);
			debouncer.add("ctx-1", makeMessage({ id: "3", text: "c" }));

			// 80ms since first, but only 0ms since last — nothing should flush
			expect(flushed).toHaveLength(0);

			// Wait for timeout from last message
			await Bun.sleep(80);

			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.messages).toHaveLength(3);
		});
	});

	describe("independent context keys", () => {
		test("different contexts flush independently", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ text: "from ctx-1" }));
			debouncer.add("ctx-2", makeMessage({ text: "from ctx-2" }));

			await Bun.sleep(80);

			expect(flushed).toHaveLength(2);
			const keys = flushed.map((f) => f.contextKey).sort();
			expect(keys).toEqual(["ctx-1", "ctx-2"]);
		});

		test("adding to one context does not reset another", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 60,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ text: "first" }));
			await Bun.sleep(40);

			// Adding to ctx-2 should NOT reset ctx-1's timer
			debouncer.add("ctx-2", makeMessage({ text: "second" }));
			await Bun.sleep(30);

			// ctx-1 should have flushed (70ms > 60ms timeout)
			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.contextKey).toBe("ctx-1");

			// ctx-2 hasn't flushed yet (30ms < 60ms)
			await Bun.sleep(50);
			expect(flushed).toHaveLength(2);
			expect(flushed[1]!.contextKey).toBe("ctx-2");
		});
	});

	describe("cancel", () => {
		test("cancels pending buffer and timer", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ text: "pending" }));
			const cancelled = debouncer.cancel("ctx-1");

			expect(cancelled).toHaveLength(1);
			expect(cancelled[0]!.text).toBe("pending");

			// Wait past timeout — should NOT flush
			await Bun.sleep(80);
			expect(flushed).toHaveLength(0);
		});

		test("cancel on empty context returns empty array", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: () => {},
			});

			const cancelled = debouncer.cancel("nonexistent");
			expect(cancelled).toHaveLength(0);
		});

		test("cancel does not affect other contexts", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ text: "keep" }));
			debouncer.add("ctx-2", makeMessage({ text: "cancel" }));

			debouncer.cancel("ctx-2");

			await Bun.sleep(80);

			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.contextKey).toBe("ctx-1");
		});
	});

	describe("flush", () => {
		test("flushes immediately without waiting for timeout", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 5000, // very long
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage({ text: "urgent" }));
			debouncer.flush("ctx-1");

			expect(flushed).toHaveLength(1);
			expect(flushed[0]!.messages[0]!.text).toBe("urgent");
		});

		test("flush on empty context does nothing", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.flush("nonexistent");
			expect(flushed).toHaveLength(0);
		});

		test("flush prevents subsequent timeout flush", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage());
			debouncer.flush("ctx-1");

			// Wait past timeout
			await Bun.sleep(80);

			// Should only have flushed once (the manual flush)
			expect(flushed).toHaveLength(1);
		});
	});

	describe("hasPending", () => {
		test("returns false for empty context", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: () => {},
			});

			expect(debouncer.hasPending("ctx-1")).toBe(false);
		});

		test("returns true when messages are buffered", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: () => {},
			});

			debouncer.add("ctx-1", makeMessage());
			expect(debouncer.hasPending("ctx-1")).toBe(true);
		});

		test("returns false after flush", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: () => {},
			});

			debouncer.add("ctx-1", makeMessage());
			debouncer.flush("ctx-1");
			expect(debouncer.hasPending("ctx-1")).toBe(false);
		});

		test("returns false after cancel", () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: () => {},
			});

			debouncer.add("ctx-1", makeMessage());
			debouncer.cancel("ctx-1");
			expect(debouncer.hasPending("ctx-1")).toBe(false);
		});
	});

	describe("dispose", () => {
		test("clears all buffers and timers", async () => {
			debouncer = new MessageDebouncer({
				timeoutMs: 50,
				onFlush: (contextKey, messages) => {
					flushed.push({ contextKey, messages });
				},
			});

			debouncer.add("ctx-1", makeMessage());
			debouncer.add("ctx-2", makeMessage());
			debouncer.dispose();

			await Bun.sleep(80);
			expect(flushed).toHaveLength(0);
		});
	});
});

describe("mergeMessages", () => {
	test("single message returns as-is", () => {
		const msg = makeMessage({ text: "hello" });
		const merged = mergeMessages([msg]);

		expect(merged.text).toBe("hello");
		expect(merged.id).toBe(msg.id);
	});

	test("concatenates text with newlines", () => {
		const messages = [
			makeMessage({ id: "1", text: "hello" }),
			makeMessage({ id: "2", text: "world" }),
			makeMessage({ id: "3", text: "!" }),
		];

		const merged = mergeMessages(messages);
		expect(merged.text).toBe("hello\nworld\n!");
	});

	test("uses first message for identity fields", () => {
		const messages = [
			makeMessage({ id: "first", chatId: "chat-A", senderId: "user-A" }),
			makeMessage({ id: "second", chatId: "chat-A", senderId: "user-A" }),
		];

		const merged = mergeMessages(messages);
		expect(merged.id).toBe("first");
		expect(merged.chatId).toBe("chat-A");
		expect(merged.senderId).toBe("user-A");
	});

	test("uses last message timestamp", () => {
		const messages = [
			makeMessage({ timestamp: new Date("2026-03-21T10:00:00Z") }),
			makeMessage({ timestamp: new Date("2026-03-21T10:00:05Z") }),
		];

		const merged = mergeMessages(messages);
		expect(merged.timestamp).toEqual(new Date("2026-03-21T10:00:05Z"));
	});

	test("collects media from all messages", () => {
		const messages = [
			makeMessage({
				media: [{ type: "image", url: "http://img1.jpg", mimeType: "image/jpeg" }],
			}),
			makeMessage({ text: "no media" }),
			makeMessage({
				media: [{ type: "image", url: "http://img2.jpg", mimeType: "image/png" }],
			}),
		];

		const merged = mergeMessages(messages);
		expect(merged.media).toHaveLength(2);
		expect(merged.media?.[0]?.url).toBe("http://img1.jpg");
		expect(merged.media?.[1]?.url).toBe("http://img2.jpg");
	});

	test("throws on empty array", () => {
		expect(() => mergeMessages([])).toThrow();
	});
});
