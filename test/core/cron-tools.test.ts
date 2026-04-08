import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { CronJobStore } from "../../src/core/cron-jobs.js";
import { buildCronPromptBlock, createCronTools } from "../../src/core/cron-tools.js";

function setupStore() {
	const dataDir = mkdtempSync(join(tmpdir(), "pion-cron-tools-"));
	return {
		dataDir,
		store: new CronJobStore({ dataDir }),
		dispose: () => rmSync(dataDir, { recursive: true, force: true }),
	};
}

describe("createCronTools", () => {
	test("creates reminder jobs and lists them", async () => {
		const { store, dispose } = setupStore();
		try {
			const tools = createCronTools({
				store,
				cronAgentConfigured: true,
				availableSkills: ["web-browse", "supervise"],
				chatId: "chat-1",
				contextKey: "telegram:contact:chat-1",
				provider: "telegram",
			});
			const tool = tools.find((entry) => entry.name === "cronjob");
			if (!tool) throw new Error("cronjob tool missing");

			const createResult = await tool.execute(
				"tool-1",
				{
					action: "create",
					kind: "reminder",
					name: "invoice reminder",
					schedule: "0 18 * * 5",
					message: "Send the invoice.",
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			const createText =
				createResult.content[0]?.type === "text" ? createResult.content[0].text : "";
			expect(createText).toContain("Created scheduled reminder job");
			expect(createText).toContain("invoice reminder");

			const listResult = await tool.execute(
				"tool-2",
				{ action: "list" },
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			const listText = listResult.content[0]?.type === "text" ? listResult.content[0].text : "";
			expect(listText).toContain("invoice reminder");
			expect(listText).toContain("telegram:chat-1");
		} finally {
			dispose();
		}
	});

	test("creates script jobs with commands", async () => {
		const { store, dispose } = setupStore();
		try {
			const tools = createCronTools({
				store,
				cronAgentConfigured: true,
				availableSkills: ["web-browse", "supervise"],
				chatId: "chat-1",
				contextKey: "telegram:contact:chat-1",
				provider: "telegram",
			});
			const tool = tools.find((entry) => entry.name === "cronjob");
			if (!tool) throw new Error("cronjob tool missing");

			const createResult = await tool.execute(
				"tool-script",
				{
					action: "create",
					kind: "script",
					name: "job digest",
					schedule: "0 9 * * *",
					command: "printf 'hello'",
					prompt: "Review this output",
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			const createText =
				createResult.content[0]?.type === "text" ? createResult.content[0].text : "";
			expect(createText).toContain("Created scheduled script job");
			expect(store.listJobs()[0]?.command).toBe("printf 'hello'");
		} finally {
			dispose();
		}
	});

	test("creates agent jobs without depending on chat-routing agent names and can run them immediately", async () => {
		const { store, dispose } = setupStore();
		let runNowJobId: string | undefined;
		try {
			const tools = createCronTools({
				store,
				cronAgentConfigured: true,
				availableSkills: ["web-browse", "supervise"],
				chatId: "chat-1",
				contextKey: "telegram:contact:chat-1",
				provider: "telegram",
				onRunNow: async (jobId) => {
					runNowJobId = jobId;
				},
			});
			const tool = tools.find((entry) => entry.name === "cronjob");
			if (!tool) throw new Error("cronjob tool missing");

			const createResult = await tool.execute(
				"tool-1",
				{
					action: "create",
					kind: "agent",
					name: "weekly research",
					schedule: "0 9 * * 1",
					prompt: "Search for new energy-sector news and give a short opinionated summary.",
					skills: ["web-browse"],
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			const createText =
				createResult.content[0]?.type === "text" ? createResult.content[0].text : "";
			expect(createText).toContain("weekly research");
			const created = store.listJobs()[0];
			expect(created?.skills).toEqual(["web-browse"]);
			expect(created?.agentName).toBeUndefined();

			await tool.execute(
				"tool-2",
				{ action: "run_now", id: created?.id },
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			expect(runNowJobId).toBe(created?.id);
		} finally {
			dispose();
		}
	});

	test("rejects agent jobs when cron agent defaults are not configured", async () => {
		const { store, dispose } = setupStore();
		try {
			const tools = createCronTools({
				store,
				cronAgentConfigured: false,
				availableSkills: ["web-browse"],
				chatId: "chat-1",
				contextKey: "telegram:contact:chat-1",
				provider: "telegram",
			});
			const tool = tools.find((entry) => entry.name === "cronjob");
			if (!tool) throw new Error("cronjob tool missing");

			const result = await tool.execute(
				"tool-1",
				{
					action: "create",
					kind: "agent",
					name: "broken",
					schedule: "0 9 * * 1",
					prompt: "Do a thing.",
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			expect((result.content[0] as { text: string }).text).toContain("cron.agent");
		} finally {
			dispose();
		}
	});

	test("rejects unknown skills and non-cron schedule strings", async () => {
		const { store, dispose } = setupStore();
		try {
			const tools = createCronTools({
				store,
				cronAgentConfigured: true,
				availableSkills: ["web-browse"],
				chatId: "chat-1",
				contextKey: "telegram:contact:chat-1",
				provider: "telegram",
			});
			const tool = tools.find((entry) => entry.name === "cronjob");
			if (!tool) throw new Error("cronjob tool missing");

			const badSkill = await tool.execute(
				"tool-2",
				{
					action: "create",
					kind: "agent",
					name: "broken",
					schedule: "0 9 * * 1",
					prompt: "Do a thing.",
					skills: ["supervise"],
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			expect((badSkill.content[0] as { text: string }).text).toContain("Unknown skill names");

			const badSchedule = await tool.execute(
				"tool-3",
				{
					action: "create",
					kind: "reminder",
					name: "broken",
					schedule: "every monday at 9",
					message: "ping",
				},
				undefined,
				undefined,
				{} as ExtensionCommandContext,
			);
			expect((badSchedule.content[0] as { text: string }).text).toContain(
				"Schedule must be a 5-field cron expression",
			);
		} finally {
			dispose();
		}
	});
});

describe("buildCronPromptBlock", () => {
	test("explains cron-agent defaults without reusing routed agent names", () => {
		const prompt = buildCronPromptBlock(true);
		expect(prompt).toContain("Scheduled agent jobs use the daemon's cron.agent configuration");
		expect(prompt).toContain("Scheduled agent jobs must be self-contained");
	});
});
