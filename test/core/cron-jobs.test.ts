import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronJobStore } from "../../src/core/cron-jobs.js";

let dataDir: string;
let store: CronJobStore;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pion-cron-jobs-"));
	store = new CronJobStore({ dataDir });
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("CronJobStore", () => {
	test("creates reminder jobs with persisted schedule metadata", () => {
		const job = store.createJob(
			{
				kind: "reminder",
				name: "invoice reminder",
				schedule: "0 18 * * 5",
				delivery: { provider: "telegram", chatId: "chat-1" },
				message: "Send the invoice.",
			},
			new Date("2026-04-03T10:00:00Z"),
		);

		expect(job.id).toMatch(/^cron_/);
		expect(job.state).toBe("scheduled");
		expect(job.nextRunAt).toBe("2026-04-03T18:00:00.000Z");
		expect(store.listJobs()).toHaveLength(1);

		const persisted = JSON.parse(readFileSync(store.jobsFile, "utf-8"));
		expect(persisted.jobs).toHaveLength(1);
		expect(persisted.jobs[0].message).toBe("Send the invoice.");
	});

	test("claims due jobs, marks them running, and advances nextRunAt before execution", () => {
		const job = store.createJob(
			{
				kind: "reminder",
				name: "daily",
				schedule: "0 9 * * *",
				delivery: { provider: "telegram", chatId: "chat-1" },
				message: "ping",
			},
			new Date("2026-04-03T08:00:00Z"),
		);

		const [claimed] = store.claimDueJobs(new Date("2026-04-03T09:00:00Z"));
		expect(claimed?.id).toBe(job.id);

		const reloaded = store.getJob(job.id);
		expect(reloaded?.state).toBe("running");
		expect(reloaded?.lastRunAt).toBe("2026-04-03T09:00:00.000Z");
		expect(reloaded?.nextRunAt).toBe("2026-04-04T09:00:00.000Z");
	});

	test("can pause, resume, update, and remove jobs", () => {
		const job = store.createJob(
			{
				kind: "agent",
				name: "weekly research",
				schedule: "0 9 * * 1",
				delivery: { provider: "telegram", chatId: "chat-1" },
				agentName: "main",
				skills: ["web-browse"],
				prompt: "Summarize the week.",
			},
			new Date("2026-04-03T08:00:00Z"),
		);

		const paused = store.pauseJob(job.id);
		expect(paused?.state).toBe("paused");
		expect(paused?.enabled).toBe(false);

		const resumed = store.resumeJob(job.id, new Date("2026-04-03T08:30:00Z"));
		expect(resumed?.state).toBe("scheduled");
		expect(resumed?.enabled).toBe(true);
		expect(resumed?.nextRunAt).toBe("2026-04-06T09:00:00.000Z");

		const updated = store.updateJob(
			job.id,
			{ name: "monday research", prompt: "Use sources and give a concise opinion." },
			new Date("2026-04-03T08:30:00Z"),
		);
		expect(updated?.name).toBe("monday research");
		expect(updated?.prompt).toContain("concise opinion");

		store.removeJob(job.id);
		expect(store.getJob(job.id)).toBeUndefined();
	});

	test("persists script job command", () => {
		const job = store.createJob(
			{
				kind: "script",
				name: "job digest",
				schedule: "0 9 * * *",
				delivery: { provider: "telegram", chatId: "chat-1", contextKey: "telegram:contact:chat-1" },
				command: "printf 'hello'",
				prompt: "Review this output",
			},
			new Date("2026-04-03T08:00:00Z"),
		);

		expect(job.kind).toBe("script");
		expect(job.command).toBe("printf 'hello'");
		expect(store.getJob(job.id)?.command).toBe("printf 'hello'");
	});

	test("records run output and terminal status", () => {
		const job = store.createJob(
			{
				kind: "reminder",
				name: "daily",
				schedule: "0 9 * * *",
				delivery: { provider: "telegram", chatId: "chat-1" },
				message: "ping",
			},
			new Date("2026-04-03T08:00:00Z"),
		);
		store.claimDueJobs(new Date("2026-04-03T09:00:00Z"));
		const outputPath = store.writeRunOutput(job.id, new Date("2026-04-03T09:00:00Z"), {
			status: "sent",
			text: "ping",
		});
		const completed = store.recordRunSuccess(job.id, {
			lastStatus: "sent",
			outputPath,
		});

		expect(completed?.state).toBe("scheduled");
		expect(completed?.lastStatus).toBe("sent");
		expect(completed?.lastOutputPath).toBe(outputPath);

		const failed = store.recordRunFailure(job.id, "boom");
		expect(failed?.state).toBe("failed");
		expect(failed?.lastError).toBe("boom");
	});
});
