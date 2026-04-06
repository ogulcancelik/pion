import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/schema.js";
import { resolveDefaultMonitorTarget } from "../../src/core/monitor-target.js";
import { RuntimeInspectorStore } from "../../src/core/runtime-inspector.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pion-monitor-target-"));
}

function makeConfig(agentNames: string[]): Config {
	return {
		dataDir: undefined,
		agents: Object.fromEntries(
			agentNames.map((name) => [
				name,
				{
					model: "anthropic/claude-sonnet-4-20250514",
					workspace: `/tmp/pion/agents/${name}`,
					skills: [],
				},
			]),
		),
		routes: [],
	};
}

describe("resolveDefaultMonitorTarget", () => {
	test("prefers the most recently active context for the default main agent", () => {
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
				responseLength: 20,
			});
			store.registerContext({
				agentName: "friend",
				contextKey: "telegram:contact:friend-1",
				provider: "telegram",
				chatId: "chat-friend",
			});
			store.handleRuntimeEvent({
				id: "evt-friend",
				timestamp: "2026-04-06T12:00:00.000Z",
				source: "pion",
				contextKey: "telegram:contact:friend-1",
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent: 1,
				responseLength: 30,
			});

			const target = resolveDefaultMonitorTarget(makeConfig(["main", "friend"]), dataDir);
			expect(target).toMatchObject({
				agentName: "main",
				contextKey: "telegram:contact:newer",
				sessionName: "telegram-contact-newer",
			});
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("falls back to the most recently modified session file when no runtime snapshot exists", () => {
		const dataDir = makeTempDir();
		try {
			const sessionsDir = join(dataDir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const older = join(sessionsDir, "telegram-contact-older.jsonl");
			const newer = join(sessionsDir, "telegram-contact-newer.jsonl");
			writeFileSync(older, '{"type":"session"}\n');
			writeFileSync(newer, '{"type":"session"}\n');
			utimesSync(older, new Date("2026-04-06T10:00:00.000Z"), new Date("2026-04-06T10:00:00.000Z"));
			utimesSync(newer, new Date("2026-04-06T11:00:00.000Z"), new Date("2026-04-06T11:00:00.000Z"));

			const target = resolveDefaultMonitorTarget(makeConfig(["main"]), dataDir);
			expect(target).toMatchObject({
				agentName: "main",
				sessionFile: newer,
				sessionName: "telegram-contact-newer",
			});
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
