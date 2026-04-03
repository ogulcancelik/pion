import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextCronOccurrence, parseCronExpression } from "./cron-schedule.js";

export type CronJobKind = "agent" | "reminder";
export type CronJobState = "scheduled" | "running" | "paused" | "completed" | "failed";

export interface CronJobDelivery {
	provider: "telegram";
	chatId: string;
	contextKey?: string;
}

export interface CronJob {
	id: string;
	kind: CronJobKind;
	name: string;
	schedule: {
		expression: string;
	};
	enabled: boolean;
	state: CronJobState;
	nextRunAt: string;
	lastRunAt?: string;
	lastStatus?: string;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
	delivery: CronJobDelivery;
	agentName?: string;
	skills: string[];
	prompt?: string;
	message?: string;
	lastOutputPath?: string;
}

export interface CreateCronJobInput {
	kind: CronJobKind;
	name: string;
	schedule: string;
	delivery: CronJobDelivery;
	agentName?: string;
	skills?: string[];
	prompt?: string;
	message?: string;
}

export interface UpdateCronJobInput {
	name?: string;
	schedule?: string;
	agentName?: string;
	skills?: string[];
	prompt?: string;
	message?: string;
}

interface PersistedCronJobs {
	version: 1;
	jobs: CronJob[];
}

export class CronJobStore {
	readonly cronDir: string;
	readonly jobsFile: string;
	readonly outputDir: string;

	constructor({ dataDir }: { dataDir: string }) {
		this.cronDir = join(dataDir, "cron");
		this.jobsFile = join(this.cronDir, "jobs.json");
		this.outputDir = join(this.cronDir, "output");
		this.ensureDirs();
		if (!existsSync(this.jobsFile)) {
			this.writeJobs([]);
		}
	}

	listJobs(): CronJob[] {
		return this.readJobs();
	}

	getJob(id: string): CronJob | undefined {
		return this.readJobs().find((job) => job.id === id);
	}

	createJob(input: CreateCronJobInput, now = new Date()): CronJob {
		const schedule = parseCronExpression(input.schedule);
		const nextRunAt = nextCronOccurrence(schedule, now);
		if (!nextRunAt) {
			throw new Error(`Could not compute next run for schedule: ${input.schedule}`);
		}
		const timestamp = now.toISOString();
		const job: CronJob = {
			id: `cron_${randomUUID().slice(0, 8)}`,
			kind: input.kind,
			name: input.name,
			schedule: { expression: schedule.expression },
			enabled: true,
			state: "scheduled",
			nextRunAt: nextRunAt.toISOString(),
			createdAt: timestamp,
			updatedAt: timestamp,
			delivery: input.delivery,
			agentName: input.agentName,
			skills: input.skills ?? [],
			prompt: input.prompt,
			message: input.message,
		};

		const jobs = this.readJobs();
		jobs.push(job);
		this.writeJobs(jobs);
		return job;
	}

	updateJob(id: string, input: UpdateCronJobInput, now = new Date()): CronJob | undefined {
		const jobs = this.readJobs();
		const index = jobs.findIndex((job) => job.id === id);
		if (index === -1) return undefined;
		const existing = jobs[index];
		if (!existing) return undefined;

		let nextRunAt = existing.nextRunAt;
		let expression = existing.schedule.expression;
		if (input.schedule !== undefined) {
			const schedule = parseCronExpression(input.schedule);
			expression = schedule.expression;
			nextRunAt = (nextCronOccurrence(schedule, now) ?? now).toISOString();
		}

		const updated: CronJob = {
			...existing,
			name: input.name ?? existing.name,
			schedule: { expression },
			nextRunAt,
			agentName: input.agentName ?? existing.agentName,
			skills: input.skills ?? existing.skills,
			prompt: input.prompt ?? existing.prompt,
			message: input.message ?? existing.message,
			updatedAt: now.toISOString(),
		};
		jobs[index] = updated;
		this.writeJobs(jobs);
		return updated;
	}

	pauseJob(id: string, now = new Date()): CronJob | undefined {
		return this.patchJob(id, (job) => ({
			...job,
			enabled: false,
			state: "paused",
			updatedAt: now.toISOString(),
		}));
	}

	resumeJob(id: string, now = new Date()): CronJob | undefined {
		return this.patchJob(id, (job) => {
			const nextRunAt = nextCronOccurrence(parseCronExpression(job.schedule.expression), now);
			if (!nextRunAt) {
				throw new Error(`Could not compute next run for schedule: ${job.schedule.expression}`);
			}
			return {
				...job,
				enabled: true,
				state: "scheduled",
				nextRunAt: nextRunAt.toISOString(),
				updatedAt: now.toISOString(),
			};
		});
	}

	removeJob(id: string): boolean {
		const jobs = this.readJobs();
		const next = jobs.filter((job) => job.id !== id);
		if (next.length === jobs.length) return false;
		this.writeJobs(next);
		return true;
	}

	claimDueJobs(now = new Date()): CronJob[] {
		const claimed: CronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			if (!isDue(job, now)) {
				return job;
			}
			const claimedJob = this.buildClaimedJob(job, now);
			claimed.push(claimedJob);
			return claimedJob;
		});
		this.writeJobs(jobs);
		return claimed;
	}

	claimJobNow(id: string, now = new Date()): CronJob | undefined {
		return this.patchJob(id, (job) => this.buildClaimedJob(job, now));
	}

	recordRunSuccess(
		id: string,
		result: { lastStatus: string; outputPath?: string },
		now = new Date(),
	): CronJob | undefined {
		return this.patchJob(id, (job) => ({
			...job,
			state: job.enabled ? "scheduled" : "paused",
			lastStatus: result.lastStatus,
			lastError: undefined,
			lastOutputPath: result.outputPath ?? job.lastOutputPath,
			updatedAt: now.toISOString(),
		}));
	}

	recordRunFailure(id: string, error: string, now = new Date()): CronJob | undefined {
		return this.patchJob(id, (job) => ({
			...job,
			state: "failed",
			lastStatus: "failed",
			lastError: error,
			updatedAt: now.toISOString(),
		}));
	}

	writeRunOutput(jobId: string, runAt: Date, payload: unknown): string {
		const dir = join(this.outputDir, jobId);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, `${slugTimestamp(runAt.toISOString())}.json`);
		writeFileSync(filePath, `${JSON.stringify(payload, null, "\t")}\n`, "utf-8");
		return filePath;
	}

	private buildClaimedJob(job: CronJob, now: Date): CronJob {
		const nextRunAt = nextCronOccurrence(parseCronExpression(job.schedule.expression), now);
		if (!nextRunAt) {
			throw new Error(`Could not compute next run for schedule: ${job.schedule.expression}`);
		}
		return {
			...job,
			state: "running",
			lastRunAt: now.toISOString(),
			nextRunAt: nextRunAt.toISOString(),
			updatedAt: now.toISOString(),
			lastError: undefined,
		};
	}

	private patchJob(id: string, updater: (job: CronJob) => CronJob): CronJob | undefined {
		const jobs = this.readJobs();
		const index = jobs.findIndex((job) => job.id === id);
		if (index === -1) return undefined;
		const existing = jobs[index];
		if (!existing) return undefined;
		const updated = updater(existing);
		jobs[index] = updated;
		this.writeJobs(jobs);
		return updated;
	}

	private ensureDirs(): void {
		mkdirSync(this.cronDir, { recursive: true });
		mkdirSync(this.outputDir, { recursive: true });
	}

	private readJobs(): CronJob[] {
		const raw = JSON.parse(readFileSync(this.jobsFile, "utf-8")) as PersistedCronJobs;
		return Array.isArray(raw.jobs) ? raw.jobs : [];
	}

	private writeJobs(jobs: CronJob[]): void {
		const tempFile = `${this.jobsFile}.tmp`;
		writeFileSync(tempFile, `${JSON.stringify({ version: 1, jobs }, null, "\t")}\n`, "utf-8");
		renameSync(tempFile, this.jobsFile);
	}
}

function isDue(job: CronJob, now: Date): boolean {
	return (
		job.enabled &&
		job.state !== "paused" &&
		job.state !== "running" &&
		new Date(job.nextRunAt) <= now
	);
}

function slugTimestamp(timestamp: string): string {
	return timestamp.replace(/[:.]/g, "-");
}
