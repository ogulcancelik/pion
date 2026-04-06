import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	Compactor,
	buildContinuationSeedPrompt,
	buildHandoffPrompt,
	extractConversation,
	extractHandoffBlock,
	shouldAutoCompact,
} from "../../src/core/compactor.js";

describe("Compactor", () => {
	const testDir = join(import.meta.dir, ".test-compactor");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("extractConversation", () => {
		// Helper to create pi-agent session format messages
		const msg = (message: object) => JSON.stringify({ type: "message", message });
		const sessionMeta = () => JSON.stringify({ type: "session", version: 3, id: "test" });

		test("extracts from pi-agent session format (wrapped messages)", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({ role: "user", content: [{ type: "text", text: "Hello" }] }),
				msg({ role: "assistant", content: [{ type: "text", text: "Hi there!" }] }),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{ role: "user", content: "Hello", tools: [] },
				{ role: "assistant", content: "Hi there!", tools: [] },
			]);
		});

		test("extracts tool calls from assistant messages", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({ role: "user", content: [{ type: "text", text: "Check the router" }] }),
				msg({
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check that." },
						{ type: "toolCall", name: "read", arguments: { path: "src/core/router.ts" } },
						{ type: "toolCall", name: "bash", arguments: { command: "ls -la src/" } },
					],
				}),
				msg({
					role: "toolResult",
					toolCallId: "123",
					content: [{ type: "text", text: "file contents" }],
				}),
				msg({ role: "assistant", content: [{ type: "text", text: "The router looks good!" }] }),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{ role: "user", content: "Check the router", tools: [] },
				{
					role: "assistant",
					content: "Let me check that.",
					tools: ["read src/core/router.ts", "bash ls -la src/"],
				},
				{ role: "assistant", content: "The router looks good!", tools: [] },
			]);
		});

		test("extracts edit and write tool calls with paths", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({
					role: "assistant",
					content: [
						{ type: "text", text: "I'll fix that." },
						{
							type: "toolCall",
							name: "edit",
							arguments: { path: "src/daemon.ts", oldText: "x", newText: "y" },
						},
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "src/new-file.ts", content: "..." },
						},
					],
				}),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{
					role: "assistant",
					content: "I'll fix that.",
					tools: ["edit src/daemon.ts", "write src/new-file.ts"],
				},
			]);
		});

		test("skips thinking content but keeps text", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Let me think about this..." },
						{ type: "text", text: "Here's my answer." },
					],
				}),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([{ role: "assistant", content: "Here's my answer.", tools: [] }]);
		});

		test("skips toolResult messages", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({ role: "user", content: [{ type: "text", text: "Hi" }] }),
				msg({ role: "toolResult", toolCallId: "123", content: [{ type: "text", text: "result" }] }),
				msg({ role: "assistant", content: [{ type: "text", text: "Done!" }] }),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{ role: "user", content: "Hi", tools: [] },
				{ role: "assistant", content: "Done!", tools: [] },
			]);
		});

		test("skips non-message entries (session, model_change, etc)", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				JSON.stringify({ type: "session", version: 3, id: "test" }),
				JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "opus" }),
				JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
				msg({ role: "user", content: [{ type: "text", text: "Hello" }] }),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([{ role: "user", content: "Hello", tools: [] }]);
		});

		test("returns empty array for non-existent file", () => {
			const result = extractConversation(join(testDir, "nonexistent.jsonl"));
			expect(result).toEqual([]);
		});

		test("skips empty lines and invalid JSON", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({ role: "user", content: [{ type: "text", text: "Hello" }] }),
				"",
				"not json",
				msg({ role: "assistant", content: [{ type: "text", text: "Hi!" }] }),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{ role: "user", content: "Hello", tools: [] },
				{ role: "assistant", content: "Hi!", tools: [] },
			]);
		});

		test("handles user messages with image content", () => {
			const sessionFile = join(testDir, "test.jsonl");
			const lines = [
				sessionMeta(),
				msg({
					role: "user",
					content: [
						{ type: "text", text: "What's in this image?" },
						{ type: "image", source: { type: "url", url: "https://example.com/img.png" } },
					],
				}),
			];
			writeFileSync(sessionFile, lines.join("\n"));

			const result = extractConversation(sessionFile);

			expect(result).toEqual([
				{ role: "user", content: "What's in this image? [image]", tools: [] },
			]);
		});
	});

	describe("buildSummaryPrompt", () => {
		test("formats messages with tool metadata", () => {
			const { buildSummaryPrompt } = require("../../src/core/compactor.js");

			const messages: ConversationMessage[] = [
				{ role: "user", content: "Check the router", tools: [] },
				{ role: "assistant", content: "Let me look.", tools: ["read src/router.ts", "bash ls"] },
				{ role: "assistant", content: "Looks good!", tools: [] },
			];

			const prompt = buildSummaryPrompt(messages);

			expect(prompt).toContain("USER: Check the router");
			expect(prompt).toContain("[tools: read src/router.ts, bash ls]");
			expect(prompt).toContain("Let me look.");
			expect(prompt).toContain("ASSISTANT: Looks good!");
		});

		test("includes focus when provided", () => {
			const { buildSummaryPrompt } = require("../../src/core/compactor.js");

			const messages: ConversationMessage[] = [{ role: "user", content: "Hi", tools: [] }];

			const prompt = buildSummaryPrompt(messages, "the API design");

			expect(prompt).toContain("Focus especially on: the API design");
		});
	});

	describe("handoff helpers", () => {
		test("buildHandoffPrompt includes focus, pending user message, and delimiter instructions", () => {
			const prompt = buildHandoffPrompt({
				focus: "today's inbox triage",
				pendingUserMessage: "check my emails and tell me what happened today",
			});

			expect(prompt).toContain("today's inbox triage");
			expect(prompt).toContain("Pending user request:");
			expect(prompt).toContain("check my emails and tell me what happened today");
			expect(prompt).toContain("<<<PI_HANDOFF_START>>>");
			expect(prompt).toContain("<<<PI_HANDOFF_END>>>");
			expect(prompt).toContain("Do not answer the pending user request yet");
		});

		test("extractHandoffBlock returns the last delimited handoff body", () => {
			const body = extractHandoffBlock(
				"before\n<<<PI_HANDOFF_START>>>\none\n<<<PI_HANDOFF_END>>>\nafter\n<<<PI_HANDOFF_START>>>\ntwo\n<<<PI_HANDOFF_END>>>",
			);
			expect(body).toBe("two");
		});

		test("buildContinuationSeedPrompt includes archived session recall hint", () => {
			const seed = buildContinuationSeedPrompt(
				"## Context\nWe were triaging mail.",
				"/tmp/archive/telegram-contact-1.jsonl",
			);
			expect(seed).toContain("[Previous conversation handoff]");
			expect(seed).toContain('session_query("/tmp/archive/telegram-contact-1.jsonl"');
			expect(seed).toContain("We were triaging mail.");
		});

		test("shouldAutoCompact triggers at or above threshold", () => {
			expect(shouldAutoCompact(89)).toBe(false);
			expect(shouldAutoCompact(90)).toBe(true);
			expect(shouldAutoCompact(95)).toBe(true);
		});
	});

	// Integration test with actual model would go here
	// but we skip it in unit tests (needs API key)
});

// Re-export type for tests
import type { ConversationMessage } from "../../src/core/compactor.js";
