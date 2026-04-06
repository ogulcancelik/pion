import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/schema.js";
import { listMonitorContextsForAgent } from "../../src/core/monitor-target.js";
import { RuntimeInspectorStore } from "../../src/core/runtime-inspector.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pion-monitor-selection-"));
}

const config: Config = {
	agents: {
		main: {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion/agents/main",
			skills: [],
		},
		friend: {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion/agents/friend",
			skills: [],
		},
	},
	routes: [],
};

describe("listMonitorContextsForAgent", () => {
	test("returns persisted contexts for the selected agent ordered by recent activity", () => {
		const dataDir = makeTempDir();
		try {
			const store = new RuntimeInspectorStore(dataDir);
			store.registerContext({
				agentName: "main",
				contextKey: "telegram:contact:older",
				provider: "telegram",
				chatId: "chat-older",
			});
			store.handleRuntimeEvent({
				id: "evt-older",
				timestamp: "2026-04-06T10:00:00.000Z",
				source: "pion",
				contextKey: "telegram:contact:older",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 10,
			});
			store.registerContext({
				agentName: "main",
				contextKey: "telegram:contact:newer",
				provider: "telegram",
				chatId: "chat-newer",
			});
			store.handleRuntimeEvent({
				id: "evt-newer",
				timestamp: "2026-04-06T11:00:00.000Z",
				source: "pion",
				contextKey: "telegram:contact:newer",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 10,
			});
			store.registerContext({
				agentName: "friend",
				contextKey: "telegram:contact:friend-1",
				provider: "telegram",
				chatId: "chat-friend",
			});

			const contexts = listMonitorContextsForAgent(config, dataDir, "main");
			expect(contexts.map((context) => context.contextKey)).toEqual([
				"telegram:contact:newer",
				"telegram:contact:older",
			]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
