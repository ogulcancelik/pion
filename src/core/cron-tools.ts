import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type {
	CreateCronJobInput,
	CronJob,
	CronJobKind,
	CronJobStore,
	UpdateCronJobInput,
} from "./cron-jobs.js";
import { formatCronValidationError, parseCronExpression } from "./cron-schedule.js";

const cronjobSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("list"),
		Type.Literal("update"),
		Type.Literal("pause"),
		Type.Literal("resume"),
		Type.Literal("remove"),
		Type.Literal("run_now"),
	]),
	id: Type.Optional(
		Type.String({ description: "Scheduled job id for update/pause/resume/remove/run_now." }),
	),
	kind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("reminder")])),
	name: Type.Optional(Type.String()),
	schedule: Type.Optional(
		Type.String({
			description: "Accepted format in v1: a 5-field cron expression like '0 9 * * 1'.",
		}),
	),
	skills: Type.Optional(Type.Array(Type.String())),
	prompt: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
});

type CronToolParams = Static<typeof cronjobSchema>;

export interface CronToolsOptions {
	store: CronJobStore;
	cronAgentConfigured: boolean;
	availableSkills: string[];
	chatId: string;
	contextKey: string;
	provider: "telegram";
	onRunNow?: (jobId: string) => Promise<void>;
}

export function createCronTools(options: CronToolsOptions): ToolDefinition[] {
	const tool: ToolDefinition<typeof cronjobSchema> = {
		name: "cronjob",
		label: "Cron Jobs",
		description:
			"Manage daemon-owned scheduled jobs. v1 accepts 5-field cron expressions only (minute hour day-of-month month day-of-week). Use kind=reminder for fixed messages and kind=agent for a fresh self-contained background agent run that will deliver its final response directly to Telegram.",
		promptSnippet:
			"cronjob(action, ...) - create/list/update/pause/resume/remove/run_now daemon-owned scheduled jobs using 5-field cron expressions",
		promptGuidelines: [
			"For kind=agent, write a self-contained future brief for another agent run. Do not rely on current chat context or say 'as above' or 'continue from earlier'.",
			"Use kind=reminder instead of kind=agent when no reasoning or tool use is needed.",
			"Scheduled agent jobs use the daemon's cron.agent configuration, not chat-routing agent names.",
		],
		parameters: cronjobSchema,
		async execute(_toolCallId, params: CronToolParams) {
			try {
				switch (params.action) {
					case "create":
						return ok(createJob(options, params));
					case "list":
						return ok(renderJobList(options.store.listJobs()));
					case "update":
						return ok(updateJob(options, params));
					case "pause":
						return ok(changeState("pause", options, params.id));
					case "resume":
						return ok(changeState("resume", options, params.id));
					case "remove":
						return ok(removeJob(options, params.id));
					case "run_now":
						return ok(await runNow(options, params.id));
				}
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		},
	};

	return [tool as unknown as ToolDefinition];
}

export function buildCronPromptBlock(cronAgentConfigured: boolean): string {
	return [
		"<scheduled_jobs>",
		"Pion supports daemon-owned scheduled jobs through the cronjob tool.",
		cronAgentConfigured
			? "Scheduled agent jobs use the daemon's cron.agent configuration."
			: "Scheduled agent jobs require cron.agent to be configured by the operator.",
		"Scheduled agent jobs must be self-contained future briefs. Do not rely on current chat context.",
		"Use reminder jobs for fixed messages and agent jobs only when you need reasoning/tools later.",
		"v1 schedule format: 5-field cron expressions only.",
		"</scheduled_jobs>",
	].join("\n");
}

function createJob(options: CronToolsOptions, params: CronToolParams): string {
	if (!params.kind) throw new Error("kind is required for create");
	if (!params.name) throw new Error("name is required for create");
	if (!params.schedule) throw new Error("schedule is required for create");
	validateSchedule(params.schedule);
	const input = buildCreateInput(options, params.kind, params);
	const job = options.store.createJob(input);
	return `Created scheduled ${job.kind} job \`${job.id}\` (${job.name}) for ${job.delivery.provider}:${job.delivery.chatId}. Next run: ${job.nextRunAt}`;
}

function updateJob(options: CronToolsOptions, params: CronToolParams): string {
	const id = requireId(params.id, "update");
	if (params.schedule) validateSchedule(params.schedule);
	validateOptionalAgentAndSkills(options, params.skills);
	const updated = options.store.updateJob(
		id,
		compactUndefined({
			name: params.name,
			schedule: params.schedule,
			skills: params.skills,
			prompt: params.prompt,
			message: params.message,
		}) as UpdateCronJobInput,
	);
	if (!updated) throw new Error(`Job not found: ${id}`);
	return `Updated job \`${updated.id}\` (${updated.name}). Next run: ${updated.nextRunAt}`;
}

function changeState(action: "pause" | "resume", options: CronToolsOptions, id?: string): string {
	const jobId = requireId(id, action);
	const updated =
		action === "pause" ? options.store.pauseJob(jobId) : options.store.resumeJob(jobId);
	if (!updated) throw new Error(`Job not found: ${jobId}`);
	return `${action === "pause" ? "Paused" : "Resumed"} job \`${updated.id}\` (${updated.name}).`;
}

function removeJob(options: CronToolsOptions, id?: string): string {
	const jobId = requireId(id, "remove");
	if (!options.store.removeJob(jobId)) {
		throw new Error(`Job not found: ${jobId}`);
	}
	return `Removed job \`${jobId}\`.`;
}

async function runNow(options: CronToolsOptions, id?: string): Promise<string> {
	const jobId = requireId(id, "run_now");
	const job = options.store.getJob(jobId);
	if (!job) throw new Error(`Job not found: ${jobId}`);
	await options.onRunNow?.(jobId);
	return `Triggered immediate run for job \`${jobId}\` (${job.name}).`;
}

function buildCreateInput(
	options: CronToolsOptions,
	kind: CronJobKind,
	params: CronToolParams,
): CreateCronJobInput {
	validateOptionalAgentAndSkills(options, params.skills);
	if (kind === "agent") {
		if (!options.cronAgentConfigured) {
			throw new Error("Scheduled agent jobs require cron.agent to be configured in pion config.");
		}
		if (!params.prompt) {
			throw new Error("prompt is required for kind=agent");
		}
		return {
			kind,
			name: params.name ?? "",
			schedule: params.schedule ?? "",
			delivery: {
				provider: options.provider,
				chatId: options.chatId,
				contextKey: options.contextKey,
			},
			skills: params.skills ?? [],
			prompt: params.prompt,
		};
	}
	if (!params.message) {
		throw new Error("message is required for kind=reminder");
	}
	return {
		kind,
		name: params.name ?? "",
		schedule: params.schedule ?? "",
		delivery: {
			provider: options.provider,
			chatId: options.chatId,
			contextKey: options.contextKey,
		},
		message: params.message,
		skills: [],
	};
}

function validateOptionalAgentAndSkills(options: CronToolsOptions, skills?: string[]): void {
	if (!skills || skills.length === 0) return;
	const unknown = skills.filter((skill) => !options.availableSkills.includes(skill));
	if (unknown.length > 0) {
		throw new Error(`Unknown skill names: ${unknown.join(", ")}`);
	}
}

function validateSchedule(schedule: string): void {
	try {
		parseCronExpression(schedule);
	} catch (error) {
		if (error instanceof Error && error.message.includes("5-field cron expression")) {
			throw error;
		}
		throw new Error(formatCronValidationError(schedule));
	}
}

function requireId(id: string | undefined, action: string): string {
	if (!id) throw new Error(`id is required for ${action}`);
	return id;
}

function renderJobList(jobs: CronJob[]): string {
	if (jobs.length === 0) {
		return "No scheduled jobs.";
	}
	return jobs
		.map(
			(job) =>
				`- ${job.id} | ${job.kind} | ${job.name} | ${job.state} | next: ${job.nextRunAt} | delivery: ${job.delivery.provider}:${job.delivery.chatId}`,
		)
		.join("\n");
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: true } };
}

function fail(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: true } };
}

function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as Partial<T>;
}
