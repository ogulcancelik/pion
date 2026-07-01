import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeModelId,
	claudeSkillSelection,
	claudeThinkingOptions,
	readMirrorState,
} from "../../src/core/claude-session.js";
import { DEFAULT_SKILLS } from "../../src/core/default-skills.js";

describe("claudeModelId", () => {
	test("strips the provider prefix", () => {
		expect(claudeModelId("anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
	});

	test("passes through bare model ids", () => {
		expect(claudeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
	});

	test("returns undefined for empty ids so the CLI default applies", () => {
		expect(claudeModelId("")).toBeUndefined();
	});
});

describe("claudeThinkingOptions", () => {
	test("maps off to disabled thinking", () => {
		expect(claudeThinkingOptions("off")).toEqual({ thinking: { type: "disabled" } });
	});

	test("maps minimal to low effort", () => {
		expect(claudeThinkingOptions("minimal")).toEqual({ effort: "low" });
	});

	test("passes medium through as effort", () => {
		expect(claudeThinkingOptions("medium")).toEqual({ effort: "medium" });
	});

	test("returns no options when unset", () => {
		expect(claudeThinkingOptions(undefined)).toEqual({});
	});
});

describe("claudeSkillSelection", () => {
	test("always includes shared defaults", () => {
		const selection = claudeSkillSelection(undefined);
		expect(selection).toContain("pi-web-browse");
		for (const skill of DEFAULT_SKILLS) {
			expect(selection).toContain(skill);
		}
	});

	test("adds configured extras without duplicates", () => {
		const selection = claudeSkillSelection(["my-skill", "pi-web-browse"]);
		expect(selection).toContain("my-skill");
		expect(selection.filter((name) => name === "pi-web-browse")).toHaveLength(1);
	});
});

describe("readMirrorState", () => {
	const testDir = join(tmpdir(), "pion-claude-session-test");
	const sessionFile = join(testDir, "session.jsonl");

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty state for a missing file", () => {
		const state = readMirrorState(sessionFile);
		expect(state.claudeSessionId).toBeUndefined();
		expect(state.lastMessageId).toBeNull();
		expect(state.pendingSeed).toBeUndefined();
	});

	test("recovers the latest claude session id and last message id", () => {
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "claude-1" }),
				JSON.stringify({ type: "claude_session", sessionId: "old-id" }),
				JSON.stringify({
					type: "message",
					id: "user-1",
					message: { role: "user", content: [{ type: "text", text: "hi" }] },
				}),
				JSON.stringify({ type: "claude_session", sessionId: "new-id" }),
				JSON.stringify({
					type: "message",
					id: "assistant-1",
					message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				}),
			].join("\n"),
		);

		const state = readMirrorState(sessionFile);
		expect(state.claudeSessionId).toBe("new-id");
		expect(state.lastMessageId).toBe("assistant-1");
		// A resumable session must not re-send old prompts as seed.
		expect(state.pendingSeed).toBeUndefined();
	});

	test("treats a primed mirror without session id as a pending seed", () => {
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "compacted-1" }),
				JSON.stringify({
					type: "message",
					id: "summary-1",
					message: {
						role: "user",
						content: [{ type: "text", text: "[Previous conversation handoff]\n\ndetails" }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "summary-ack-1",
					message: { role: "assistant", content: [{ type: "text", text: "[Runtime note]" }] },
				}),
			].join("\n"),
		);

		const state = readMirrorState(sessionFile);
		expect(state.claudeSessionId).toBeUndefined();
		expect(state.pendingSeed).toContain("[Previous conversation handoff]");
		expect(state.lastMessageId).toBe("summary-ack-1");
	});

	test("does not replay a failed first turn as a seed", () => {
		// A turn that errored before the SDK emitted a session id leaves a
		// user message (id "user-…") and no claude_session entry.
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "claude-1" }),
				JSON.stringify({
					type: "message",
					id: "user-abc123",
					message: { role: "user", content: [{ type: "text", text: "what's the weather" }] },
				}),
			].join("\n"),
		);

		const state = readMirrorState(sessionFile);
		expect(state.pendingSeed).toBeUndefined();
		expect(state.lastMessageId).toBe("user-abc123");
	});

	test("restores last assistant usage tokens for context accounting", () => {
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "claude-1" }),
				JSON.stringify({ type: "claude_session", sessionId: "id-1" }),
				JSON.stringify({
					type: "message",
					id: "assistant-1",
					message: { role: "assistant", content: [], usage: { totalTokens: 120000 } },
				}),
				JSON.stringify({
					type: "message",
					id: "scheduled-1",
					message: { role: "assistant", content: [], usage: { totalTokens: 0 } },
				}),
			].join("\n"),
		);

		const state = readMirrorState(sessionFile);
		// The zero-usage synthetic entry must not clobber the real usage.
		expect(state.lastUsageTokens).toBe(120000);
	});

	test("skips malformed lines", () => {
		writeFileSync(
			sessionFile,
			[
				"{not json",
				JSON.stringify({ type: "claude_session", sessionId: "id-1" }),
				"also not json}",
			].join("\n"),
		);

		expect(readMirrorState(sessionFile).claudeSessionId).toBe("id-1");
	});
});
