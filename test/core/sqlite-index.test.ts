import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventBus, createPiRuntimeEvent } from "../../src/core/runtime-events.js";
import { PionSqliteIndex } from "../../src/core/sqlite-index.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("PionSqliteIndex", () => {
	test("indexes session messages, tool calls, and attachment paths from session JSONL", () => {
		const dataDir = makeTempDir("pion-sqlite-index-");
		try {
			const sessionsDir = join(dataDir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionFile = join(sessionsDir, "telegram-contact-123.jsonl");
			writeFileSync(
				sessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "session-1",
						timestamp: "2026-04-03T12:00:00.000Z",
						cwd: "/home/can/Projects/pion",
					}),
					JSON.stringify({
						type: "message",
						id: "msg-user-1",
						parentId: null,
						timestamp: "2026-04-03T12:00:01.000Z",
						message: {
							role: "user",
							content: [
								{
									type: "text",
									text: "hello there\n\n[User attached image: /tmp/pion-media/image-1.png]",
								},
							],
							timestamp: 1712145601000,
						},
					}),
					JSON.stringify({
						type: "message",
						id: "msg-assistant-1",
						parentId: "msg-user-1",
						timestamp: "2026-04-03T12:00:02.000Z",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "I checked the docs." },
								{
									type: "toolCall",
									id: "tool-read-1",
									name: "read",
									arguments: { path: "docs/architecture.md" },
								},
								{
									type: "toolCall",
									id: "tool-bash-1",
									name: "bash",
									arguments: { command: "rg -n architecture src" },
								},
							],
							provider: "anthropic",
							model: "claude-sonnet",
							usage: {
								input: 100,
								output: 25,
								cacheRead: 50,
								cacheWrite: 0,
								cost: { total: 0.12 },
							},
							stopReason: "stop",
							timestamp: 1712145602000,
						},
					}),
				].join("\n")}\n`,
			);

			const index = new PionSqliteIndex(dataDir);
			index.syncSessionFile(sessionFile);

			expect(index.searchSessionMessages("hello")).toEqual([
				expect.objectContaining({
					sessionFile,
					entryId: "msg-user-1",
					role: "user",
					text: "hello there\n\n[User attached image: /tmp/pion-media/image-1.png]",
				}),
			]);

			const toolCalls = index.listToolCalls();
			expect(toolCalls).toHaveLength(2);
			expect(toolCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionFile,
						entryId: "msg-assistant-1",
						toolCallId: "tool-bash-1",
						toolName: "bash",
						command: "rg -n architecture src",
					}),
					expect.objectContaining({
						sessionFile,
						entryId: "msg-assistant-1",
						toolCallId: "tool-read-1",
						toolName: "read",
						path: "docs/architecture.md",
					}),
				]),
			);

			expect(index.listAttachments()).toEqual([
				expect.objectContaining({
					sessionFile,
					entryId: "msg-user-1",
					kind: "image",
					path: "/tmp/pion-media/image-1.png",
				}),
			]);

			index.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("reindexes changed session files without duplicating rows", () => {
		const dataDir = makeTempDir("pion-sqlite-reindex-");
		try {
			const sessionsDir = join(dataDir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionFile = join(sessionsDir, "telegram-contact-456.jsonl");
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: "2026-04-03T12:10:00.000Z",
				cwd: "/home/can/Projects/pion",
			});
			const firstMessage = JSON.stringify({
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: "2026-04-03T12:10:01.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "first message" }],
					timestamp: 1712146201000,
				},
			});
			writeFileSync(sessionFile, `${header}\n${firstMessage}\n`);

			const index = new PionSqliteIndex(dataDir);
			index.syncSessionFile(sessionFile);
			expect(index.getRecentMessages(10)).toHaveLength(1);

			const secondMessage = JSON.stringify({
				type: "message",
				id: "msg-2",
				parentId: "msg-1",
				timestamp: "2026-04-03T12:10:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "second message" }],
					timestamp: 1712146202000,
				},
			});
			writeFileSync(sessionFile, `${header}\n${firstMessage}\n${secondMessage}\n`);
			index.syncSessionFile(sessionFile);

			const recentMessages = index.getRecentMessages(10);
			expect(recentMessages).toHaveLength(2);
			expect(recentMessages.map((row) => row.entryId).sort()).toEqual(["msg-1", "msg-2"]);
			expect(index.searchSessionMessages("second")).toEqual([
				expect.objectContaining({ entryId: "msg-2", text: "second message" }),
			]);

			index.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("indexes runtime events live and rebuilds them from runtime-event logs", () => {
		const dataDir = makeTempDir("pion-runtime-index-");
		try {
			const bus = new RuntimeEventBus(dataDir);
			const emitted = bus.emit({
				source: "pion",
				contextKey: "telegram:contact:789",
				type: "runtime_processing_complete",
				outcome: "failed",
				messagesSent: 1,
				responseLength: 42,
				errorMessage: "network timeout",
			});
			bus.emit(
				createPiRuntimeEvent("telegram:contact:789", "/tmp/session.jsonl", {
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "read",
					args: { path: "src/core/runner.ts" },
				}),
			);

			expect(bus.searchRuntimeEvents("timeout", 10)).toEqual([
				expect.objectContaining({ id: emitted.id, errorMessage: "network timeout" }),
			]);
			expect(bus.searchRuntimeEvents("runner.ts", 10)).toEqual([
				expect.objectContaining({ toolName: "read", toolPath: "src/core/runner.ts" }),
			]);

			const rebuilt = new PionSqliteIndex(dataDir);
			rebuilt.reindexAll();
			expect(rebuilt.searchRuntimeEvents("timeout", 10)).toEqual([
				expect.objectContaining({ id: emitted.id, errorMessage: "network timeout" }),
			]);
			expect(rebuilt.getRecentRuntimeEvents(10)).toHaveLength(2);

			const runtimeLog = readFileSync(
				join(dataDir, "runtime-events", "telegram-contact-789.jsonl"),
				"utf-8",
			);
			expect(runtimeLog).toContain(emitted.id);

			rebuilt.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
