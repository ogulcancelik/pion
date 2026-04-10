import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../src/config/schema.js";
import { CronJobStore } from "../../src/core/cron-jobs.js";
import { CronScheduler } from "../../src/core/cron-scheduler.js";
import { type Runner, UserFacingError } from "../../src/core/runner.js";
import type { Provider } from "../../src/providers/types.js";

let dataDir: string;
let store: CronJobStore;
let provider: Provider;
let sent: Array<{ chatId: string; text: string }>;
let handoffs: Array<{ senderId: string; text: string; isGroup: boolean; chatId: string }>;
let runnerCalls: Array<{ contextKey: string; text: string; agentConfig: AgentConfig }>;
let appendedMessages: Array<{ contextKey: string; text: string; cwd?: string }>;
let runner: Pick<Runner, "process" | "appendAssistantMessage">;
let cronAgent: AgentConfig;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pion-cron-scheduler-"));
	store = new CronJobStore({ dataDir });
	sent = [];
	handoffs = [];
	runnerCalls = [];
	appendedMessages = [];
	provider = {
		type: "telegram",
		start: mock(async () => {}),
		stop: mock(async () => {}),
		send: mock(async ({ chatId, text }) => {
			sent.push({ chatId, text });
			return { chatId, messageId: String(sent.length) };
		}),
		onMessage: mock(() => {}),
		isConnected: mock(() => true),
	};
	const workspace = join(dataDir, "agents", "cron");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "SOUL.md"), "scheduled agent soul\n");
	cronAgent = {
		model: "anthropic/test-model",
		workspace,
		thinkingLevel: "medium",
		skills: ["supervise"],
	};
	runner = {
		appendAssistantMessage: mock((contextKey, text, cwd) => {
			appendedMessages.push({ contextKey, text, cwd });
		}),
		process: mock(async (message, context, options) => {
			runnerCalls.push({
				contextKey: context.contextKey,
				text: message.text,
				agentConfig: context.agentConfig,
			});
			options?.onTextBlock?.("first block");
			options?.onTextBlock?.("second block");
			return { response: "first block\n\nsecond block", warnings: [] };
		}),
	};
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("CronScheduler", () => {
	test("executes reminder jobs and writes output logs", async () => {
		store.createJob(
			{
				kind: "reminder",
				name: "invoice reminder",
				schedule: "0 18 * * 5",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				message: "Send the invoice.",
			},
			new Date("2026-04-03T10:00:00Z"),
		);
		const scheduler = new CronScheduler({
			store,
			runner: runner as Runner,
			cronAgent,
			providers: { telegram: provider },
		});

		await scheduler.tick(new Date("2026-04-03T18:00:00Z"));

		expect(sent).toEqual([{ chatId: "chat-1", text: "Send the invoice." }]);
		expect(appendedMessages).toEqual([
			{
				contextKey: "telegram:contact:chat-1",
				text: "[Scheduled job result delivered]\n\nSend the invoice.",
				cwd: undefined,
			},
		]);
		const job = store.listJobs()[0];
		expect(job?.lastStatus).toBe("sent reminder");
		expect(job?.lastOutputPath).toBeString();
		expect(readFileSync(job?.lastOutputPath || "", "utf-8")).toContain("Send the invoice.");
	});

	test("executes script jobs and hands stdout off to the target session context", async () => {
		const created = store.createJob(
			{
				kind: "script",
				name: "job digest",
				schedule: "0 9 * * *",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				command: "printf 'hello from script'",
				prompt: "Review this output",
			},
			new Date("2026-04-03T08:00:00Z"),
		);
		const scheduler = new CronScheduler({
			store,
			runner: runner as Runner,
			cronAgent,
			providers: { telegram: provider },
			onScriptHandoff: async (message) => {
				handoffs.push({
					senderId: message.senderId,
					text: message.text,
					isGroup: message.isGroup,
					chatId: message.chatId,
				});
			},
		});

		await scheduler.runNow(created.id, new Date("2026-04-03T08:05:00Z"));

		expect(handoffs).toEqual([
			{
				senderId: "chat-1",
				chatId: "chat-1",
				isGroup: false,
				text: `[Scheduled script "job digest" output — Review this output]\n\nhello from script`,
			},
		]);
		expect(sent).toEqual([]);
		expect(store.getJob(created.id)?.lastStatus).toBe("script handoff delivered");
		const output = readFileSync(store.getJob(created.id)?.lastOutputPath || "", "utf-8");
		expect(output).toContain("hello from script");
	});

	test("executes agent jobs using cron.agent defaults and only sends the final text block", async () => {
		const created = store.createJob(
			{
				kind: "agent",
				name: "weekly research",
				schedule: "0 9 * * 1",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				skills: ["web-browse"],
				prompt: "Search for new energy-sector news and give a short opinionated summary.",
			},
			new Date("2026-04-03T08:00:00Z"),
		);
		const scheduler = new CronScheduler({
			store,
			runner: runner as Runner,
			cronAgent,
			providers: { telegram: provider },
		});

		await scheduler.runNow(created.id, new Date("2026-04-03T08:05:00Z"));

		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]?.contextKey).toContain(`cron:${created.id}:2026-04-03T08-05-00-000Z`);
		expect(runnerCalls[0]?.text).toContain("Search for new energy-sector news");
		expect(runnerCalls[0]?.agentConfig.model).toBe("anthropic/test-model");
		expect(runnerCalls[0]?.agentConfig.thinkingLevel).toBe("medium");
		expect(runnerCalls[0]?.agentConfig.skills).toEqual(["web-browse"]);
		expect(runnerCalls[0]?.agentConfig.systemPrompt).toContain(
			"You are running as a scheduled background job.",
		);
		expect(sent).toEqual([{ chatId: "chat-1", text: "second block" }]);
		expect(appendedMessages).toEqual([
			{
				contextKey: "telegram:contact:chat-1",
				text: "[Scheduled job result delivered]\n\nsecond block",
				cwd: cronAgent.workspace,
			},
		]);

		const job = store.getJob(created.id);
		expect(job?.lastStatus).toBe("sent agent response");
		const output = readFileSync(job?.lastOutputPath || "", "utf-8");
		expect(output).toContain("first block");
		expect(output).toContain("second block");
	});

	test("sends one user-facing failure notice for scheduled agent job errors", async () => {
		runner.process = mock(async (_message, _context, options) => {
			options?.onTextBlock?.("partial block that should stay hidden");
			throw new UserFacingError(
				"upstream auth failed",
				"I hit an upstream authentication/configuration problem and can't answer right now. Please try again later.",
			);
		});
		const created = store.createJob(
			{
				kind: "agent",
				name: "weekly research",
				schedule: "0 9 * * 1",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				skills: ["web-browse"],
				prompt: "Search for new energy-sector news and give a short opinionated summary.",
			},
			new Date("2026-04-03T08:00:00Z"),
		);
		const scheduler = new CronScheduler({
			store,
			runner: runner as Runner,
			cronAgent,
			providers: { telegram: provider },
		});

		await scheduler.runNow(created.id, new Date("2026-04-03T08:05:00Z"));

		expect(sent).toEqual([
			{
				chatId: "chat-1",
				text: 'Scheduled job "weekly research" failed: I hit an upstream authentication/configuration problem and can\'t answer right now. Please try again later.',
			},
		]);
		expect(appendedMessages).toEqual([]);
		const job = store.getJob(created.id);
		expect(job?.lastStatus).toBe("failed");
		expect(job?.lastError).toBe("upstream auth failed");
		expect(job?.lastOutputPath).toBeString();
		const output = readFileSync(job?.lastOutputPath || "", "utf-8");
		expect(output).toContain("partial block that should stay hidden");
		expect(output).toContain("upstream auth failed");
	});

	test("does not leak raw scheduled job errors to chat", async () => {
		runner.process = mock(async (_message, _context, options) => {
			options?.onTextBlock?.("partial block that should stay hidden");
			throw new Error("top secret stack details");
		});
		const created = store.createJob(
			{
				kind: "agent",
				name: "weekly research",
				schedule: "0 9 * * 1",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				skills: ["web-browse"],
				prompt: "Search for new energy-sector news and give a short opinionated summary.",
			},
			new Date("2026-04-03T08:00:00Z"),
		);
		const scheduler = new CronScheduler({
			store,
			runner: runner as Runner,
			cronAgent,
			providers: { telegram: provider },
		});

		await scheduler.runNow(created.id, new Date("2026-04-03T08:05:00Z"));

		expect(sent).toEqual([
			{
				chatId: "chat-1",
				text: 'Scheduled job "weekly research" failed: Sorry, I encountered an error. Please try again.',
			},
		]);
		expect(sent[0]?.text).not.toContain("top secret");
		expect(appendedMessages).toEqual([]);
		const job = store.getJob(created.id);
		expect(job?.lastStatus).toBe("failed");
		expect(job?.lastError).toBe("top secret stack details");
		expect(job?.lastOutputPath).toBeString();
		const output = readFileSync(job?.lastOutputPath || "", "utf-8");
		expect(output).toContain("partial block that should stay hidden");
		expect(output).toContain("top secret stack details");
	});
});
