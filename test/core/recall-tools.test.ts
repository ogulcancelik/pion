import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	createRecallTools,
	serializeSessionMessagesForRecall,
} from "../../src/core/recall-tools.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("serializeSessionMessagesForRecall", () => {
	test("keeps user and assistant text, includes compact tool calls, and drops tool results", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Can you inspect the auth flow?" }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I'll inspect it." },
					{
						type: "toolCall",
						id: "tool-read-1",
						name: "read",
						arguments: { path: "src/auth.ts" },
					},
					{
						type: "toolCall",
						id: "tool-edit-1",
						name: "edit",
						arguments: { path: "src/config.ts" },
					},
					{
						type: "toolCall",
						id: "tool-bash-1",
						name: "bash",
						arguments: { command: "bun test" },
					},
				],
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "stop",
			},
			{
				role: "toolResult",
				toolCallId: "tool-read-1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "full file contents we do not want" }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "We should keep token refresh in one place." }],
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "stop",
			},
		] as AgentMessage[];

		const serialized = serializeSessionMessagesForRecall(messages);
		expect(serialized).toContain("[User]: Can you inspect the auth flow?");
		expect(serialized).toContain("[Assistant]: I'll inspect it.");
		expect(serialized).toContain(
			"[Assistant tool calls]: read path=src/auth.ts; edit path=src/config.ts; bash command=bun test",
		);
		expect(serialized).toContain("[Assistant]: We should keep token refresh in one place.");
		expect(serialized).not.toContain("full file contents we do not want");
		expect(serialized).not.toContain("[Tool result]");
	});
});

describe("createRecallTools", () => {
	test("session_search groups SQLite hits by session file and returns snippets", async () => {
		const tools = createRecallTools({
			searchSessionMessages: (query) => {
				expect(query).toBe("cloudflare auth");
				return [
					{
						sessionFile: "/tmp/sessions/session-a.jsonl",
						entryId: "msg-2",
						parentId: "msg-1",
						timestamp: "2026-04-03T12:00:02.000Z",
						role: "assistant",
						text: "We should move Cloudflare auth behind one helper.",
					},
					{
						sessionFile: "/tmp/sessions/session-a.jsonl",
						entryId: "msg-1",
						parentId: null,
						timestamp: "2026-04-03T12:00:01.000Z",
						role: "user",
						text: "Can you check the Cloudflare auth callback bug?",
					},
					{
						sessionFile: "/tmp/sessions/session-b.jsonl",
						entryId: "msg-9",
						parentId: "msg-8",
						timestamp: "2026-04-02T11:00:00.000Z",
						role: "assistant",
						text: "Authentication was failing because the nonce cookie path was wrong.",
					},
				];
			},
		});

		const searchTool = tools.find((tool) => tool.name === "session_search");
		expect(searchTool).toBeDefined();

		if (!searchTool) {
			throw new Error("session_search tool missing");
		}

		const result = await searchTool.execute(
			"tool-1",
			{ query: "cloudflare auth" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("/tmp/sessions/session-a.jsonl");
		expect(text).toContain("/tmp/sessions/session-b.jsonl");
		expect(text).toContain("[assistant] We should move Cloudflare auth behind one helper.");
		expect(text).toContain("[user] Can you check the Cloudflare auth callback bug?");
		expect(text).toContain("2 hit(s)");
	});

	test("session_query serializes a session without tool results and uses the configured global query model", async () => {
		const dataDir = makeTempDir("pion-recall-tools-");
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
							content: [{ type: "text", text: "What did we decide about auth?" }],
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
								{ type: "text", text: "We agreed to centralize auth." },
								{
									type: "toolCall",
									id: "tool-read-1",
									name: "read",
									arguments: { path: "src/auth.ts" },
								},
								{
									type: "toolCall",
									id: "tool-edit-1",
									name: "edit",
									arguments: { path: "src/config.ts" },
								},
							],
							timestamp: 1712145602000,
						},
					}),
					JSON.stringify({
						type: "message",
						id: "msg-tool-1",
						parentId: "msg-assistant-1",
						timestamp: "2026-04-03T12:00:03.000Z",
						message: {
							role: "toolResult",
							toolCallId: "tool-read-1",
							content: [{ type: "text", text: "this raw read output should be dropped" }],
							timestamp: 1712145603000,
						},
					}),
				].join("\n")}\n`,
			);

			let captured:
				| {
						question: string;
						serializedConversation: string;
						modelId: string;
						provider: string;
				  }
				| undefined;

			const tools = createRecallTools({
				recallQueryModel: "anthropic/claude-haiku-4-5",
				searchSessionMessages: () => [],
				answerSessionQuestion: async ({ question, serializedConversation, queryModel }) => {
					captured = {
						question,
						serializedConversation,
						modelId: queryModel.id,
						provider: queryModel.provider,
					};
					return "They agreed to centralize auth in one helper.";
				},
			});

			const queryTool = tools.find((tool) => tool.name === "session_query");
			expect(queryTool).toBeDefined();

			const ctx = {
				model: { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200_000 },
				modelRegistry: {
					find: (provider: string, id: string) => ({ provider, id, contextWindow: 200_000 }),
				},
			} as ExtensionCommandContext;

			if (!queryTool) {
				throw new Error("session_query tool missing");
			}

			const result = await queryTool.execute(
				"tool-2",
				{ sessionPath: sessionFile, question: "What did we decide?" },
				undefined,
				undefined,
				ctx,
			);

			expect(captured).toBeDefined();
			expect(captured?.modelId).toBe("claude-haiku-4-5");
			expect(captured?.provider).toBe("anthropic");
			expect(captured?.question).toBe("What did we decide?");
			expect(captured?.serializedConversation).toContain("[User]: What did we decide about auth?");
			expect(captured?.serializedConversation).toContain(
				"[Assistant]: We agreed to centralize auth.",
			);
			expect(captured?.serializedConversation).toContain(
				"[Assistant tool calls]: read path=src/auth.ts; edit path=src/config.ts",
			);
			expect(captured?.serializedConversation).not.toContain(
				"this raw read output should be dropped",
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("They agreed to centralize auth in one helper.");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
