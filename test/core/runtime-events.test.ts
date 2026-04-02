import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RuntimeEventBus,
	createMessageReceivedRuntimeEvent,
	createPiRuntimeEvent,
} from "../../src/core/runtime-events.js";

describe("RuntimeEventBus", () => {
	function makeTempDir(): string {
		return mkdtempSync(join(tmpdir(), "pion-runtime-events-"));
	}

	test("stamps, persists, and broadcasts pion runtime events", () => {
		const dataDir = makeTempDir();
		try {
			const bus = new RuntimeEventBus(dataDir);
			const received: Array<ReturnType<typeof bus.emit>> = [];
			const unsubscribe = bus.subscribe((event) => {
				received.push(event);
			});

			const emitted = bus.emit({
				source: "pion",
				contextKey: "telegram:contact:123",
				type: "runtime_message_buffered",
				messageCount: 2,
			});

			expect(emitted.id).toBeString();
			expect(emitted.timestamp).toBeString();
			expect(received).toEqual([emitted]);

			const persisted = readFileSync(bus.getEventLogFile("telegram:contact:123"), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(persisted).toEqual([emitted]);

			unsubscribe();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("maps pi sdk events into runtime events without dropping the original payload", () => {
		const runtimeEvent = createPiRuntimeEvent("telegram:contact:123", "/tmp/session.jsonl", {
			type: "queue_update",
			steering: ["nudge"],
			followUp: ["later"],
		});

		expect(runtimeEvent.source).toBe("pi");
		expect(runtimeEvent.contextKey).toBe("telegram:contact:123");
		expect(runtimeEvent.sessionFile).toBe("/tmp/session.jsonl");
		expect(runtimeEvent.type).toBe("queue_update");
		expect(runtimeEvent.event).toEqual({
			type: "queue_update",
			steering: ["nudge"],
			followUp: ["later"],
		});
	});

	test("builds runtime message received events from provider messages", () => {
		const event = createMessageReceivedRuntimeEvent("telegram:contact:123", {
			id: "msg-1",
			chatId: "chat-1",
			senderId: "user-1",
			text: "hello there",
			media: [{ type: "image", fileName: "photo.jpg" }],
			isGroup: false,
			provider: "telegram",
			timestamp: new Date("2026-04-02T20:00:00.000Z"),
			raw: {},
		});

		expect(event).toEqual({
			source: "pion",
			contextKey: "telegram:contact:123",
			type: "runtime_message_received",
			provider: "telegram",
			chatId: "chat-1",
			messageId: "msg-1",
			senderId: "user-1",
			isGroup: false,
			text: "hello there",
			mediaCount: 1,
		});
	});
});
