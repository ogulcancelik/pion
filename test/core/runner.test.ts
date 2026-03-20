import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "../../src/core/runner.js";

describe("Runner", () => {
	const testDir = join(import.meta.dir, ".test-runner");
	let runner: Runner;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		runner = new Runner({ dataDir: testDir });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("constructor", () => {
		test("creates data directory and sessions subdirectory", () => {
			expect(existsSync(testDir)).toBe(true);
			expect(existsSync(join(testDir, "sessions"))).toBe(true);
		});
	});

	describe("getSessionFile", () => {
		test("converts colons to hyphens", () => {
			const result = runner.getSessionFile("telegram:contact:123");
			expect(result).toBe(join(testDir, "sessions", "telegram-contact-123.jsonl"));
		});

		test("converts slashes to hyphens", () => {
			const result = runner.getSessionFile("whatsapp/chat/group-xyz");
			expect(result).toBe(join(testDir, "sessions", "whatsapp-chat-group-xyz.jsonl"));
		});

		test("converts backslashes to hyphens", () => {
			const result = runner.getSessionFile("some\\back\\slash");
			expect(result).toBe(join(testDir, "sessions", "some-back-slash.jsonl"));
		});

		test("handles mixed special characters", () => {
			const result = runner.getSessionFile("tg:group/chat\\test:456");
			expect(result).toBe(join(testDir, "sessions", "tg-group-chat-test-456.jsonl"));
		});

		test("preserves already-safe keys", () => {
			const result = runner.getSessionFile("simple-key-123");
			expect(result).toBe(join(testDir, "sessions", "simple-key-123.jsonl"));
		});
	});

	describe("clearSession", () => {
		test("returns false when no active session exists", () => {
			const result = runner.clearSession("nonexistent:key");
			expect(result).toBe(false);
		});

		test("archives existing session file", () => {
			const contextKey = "telegram:contact:999";
			const sessionFile = runner.getSessionFile(contextKey);

			// Write a fake session file with a timestamp in the first entry
			const timestamp = "2025-01-15T10:30:00.000Z";
			const sessionEntry = JSON.stringify({ type: "session", version: 3, id: "test", timestamp });
			const messageEntry = JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Hello" }] },
			});
			writeFileSync(sessionFile, `${sessionEntry}\n${messageEntry}\n`);

			runner.clearSession(contextKey);

			// Original file should be gone
			expect(existsSync(sessionFile)).toBe(false);

			// Archive directory should exist
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(true);

			// Archived file should exist with timestamp slug
			// "2025-01-15T10:30:00.000Z" → "2025-01-15T10-30" after slice(0,16) + replace
			const expectedArchive = join(archiveDir, "telegram-contact-999-2025-01-15T10-30.jsonl");
			expect(existsSync(expectedArchive)).toBe(true);

			// Content should be preserved
			const archivedContent = readFileSync(expectedArchive, "utf-8");
			expect(archivedContent).toContain("Hello");
		});

		test("creates archive directory if it doesn't exist", () => {
			const contextKey = "test:archive:dir";
			const sessionFile = runner.getSessionFile(contextKey);
			const archiveDir = join(testDir, "sessions", "archive");

			// Ensure archive dir doesn't exist yet
			expect(existsSync(archiveDir)).toBe(false);

			// Write a session file
			writeFileSync(sessionFile, JSON.stringify({ type: "session", timestamp: "2025-06-01T12:00:00Z" }) + "\n");

			runner.clearSession(contextKey);

			expect(existsSync(archiveDir)).toBe(true);
		});

		test("handles archive collision (same minute)", () => {
			const contextKey = "telegram:contact:collision";
			const sessionFile = runner.getSessionFile(contextKey);
			const archiveDir = join(testDir, "sessions", "archive");
			mkdirSync(archiveDir, { recursive: true });

			const timestamp = "2025-03-10T14:20:00.000Z";
			const slug = "2025-03-10T14-20";
			const safeKey = "telegram-contact-collision";

			// Pre-create an archive file to force collision
			const existingArchive = join(archiveDir, `${safeKey}-${slug}.jsonl`);
			writeFileSync(existingArchive, "existing\n");

			// Write session file
			writeFileSync(sessionFile, JSON.stringify({ type: "session", timestamp }) + "\n");

			runner.clearSession(contextKey);

			// Should create a -1 suffixed file
			const collisionArchive = join(archiveDir, `${safeKey}-${slug}-1.jsonl`);
			expect(existsSync(collisionArchive)).toBe(true);

			// Original archive should still be there
			expect(existsSync(existingArchive)).toBe(true);
		});

		test("does nothing to files when session file doesn't exist", () => {
			const contextKey = "no:file:exists";

			// No session file on disk
			runner.clearSession(contextKey);

			// Archive dir should not be created (no file to archive)
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(false);
		});

		test("resets warning state", () => {
			// We can't directly check warningState (private), but clearSession
			// should not throw when clearing non-existent warning state
			expect(() => runner.clearSession("some:key")).not.toThrow();
		});
	});

	describe("primeSessionWithSummary", () => {
		test("creates a valid JSONL file", () => {
			const contextKey = "telegram:contact:prime";
			runner.primeSessionWithSummary(contextKey, "User asked about weather and got a forecast.");

			const sessionFile = runner.getSessionFile(contextKey);
			expect(existsSync(sessionFile)).toBe(true);

			const content = readFileSync(sessionFile, "utf-8");
			const lines = content.trim().split("\n");

			// Should have exactly 2 lines: session header + user message
			expect(lines.length).toBe(2);

			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});

		test("session header has correct format", () => {
			runner.primeSessionWithSummary("test:session:header", "Summary text");

			const sessionFile = runner.getSessionFile("test:session:header");
			const content = readFileSync(sessionFile, "utf-8");
			const firstLine = JSON.parse(content.split("\n")[0]!);

			expect(firstLine.type).toBe("session");
			expect(firstLine.version).toBe(3);
			expect(firstLine.id).toMatch(/^compacted-/);
			expect(firstLine.timestamp).toBeDefined();
			expect(firstLine.cwd).toBeDefined();
		});

		test("user message wraps summary with prefix", () => {
			const summary = "User discussed API design for a REST endpoint.";
			runner.primeSessionWithSummary("test:summary:wrap", summary);

			const sessionFile = runner.getSessionFile("test:summary:wrap");
			const content = readFileSync(sessionFile, "utf-8");
			const secondLine = JSON.parse(content.split("\n")[1]!);

			expect(secondLine.type).toBe("message");
			expect(secondLine.id).toMatch(/^summary-/);
			expect(secondLine.message.role).toBe("user");
			expect(secondLine.message.content).toBeArrayOfSize(1);
			expect(secondLine.message.content[0].type).toBe("text");
			expect(secondLine.message.content[0].text).toBe(
				`[Previous session summary]\n\n${summary}`,
			);
		});

		test("archives existing session before priming", () => {
			const contextKey = "test:prime:archive";
			const sessionFile = runner.getSessionFile(contextKey);

			// Write an existing session
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", timestamp: "2025-01-01T00:00:00Z" }) + "\n",
			);

			// Prime with new summary (should archive old one first)
			runner.primeSessionWithSummary(contextKey, "New summary");

			// Old session should be archived
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(true);

			// New session file should exist with new content
			expect(existsSync(sessionFile)).toBe(true);
			const content = readFileSync(sessionFile, "utf-8");
			expect(content).toContain("New summary");
			expect(content).not.toContain("2025-01-01T00:00:00Z");
		});
	});

	describe("getActiveContextKeys", () => {
		test("returns empty array when no sessions exist", () => {
			expect(runner.getActiveContextKeys()).toEqual([]);
		});
	});

	describe("isStreaming", () => {
		test("returns false for unknown context key", () => {
			expect(runner.isStreaming("unknown:key")).toBe(false);
		});
	});

	describe("steer", () => {
		test("returns false for unknown context key", () => {
			const result = runner.steer("unknown:key", "change direction");
			expect(result).resolves.toBe(false);
		});
	});

	describe("abort", () => {
		test("returns false for unknown context key", async () => {
			expect(await runner.abort("unknown:key")).toBe(false);
		});
	});
});
