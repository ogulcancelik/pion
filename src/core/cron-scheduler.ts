import { execSync } from "node:child_process";
import type { AgentConfig } from "../config/schema.js";
import { createTelegramTools } from "../providers/telegram-tools.js";
import type { Message, Provider } from "../providers/types.js";
import type { CronJob, CronJobStore } from "./cron-jobs.js";
import { type Runner, getUserFacingErrorMessage } from "./runner.js";

const DEFAULT_TICK_MS = 60_000;
const CRON_AGENT_NOTE =
	"You are running as a scheduled background job. No user is present. Complete the task fully and write a final response that can be delivered directly to the configured Telegram chat.";

class HandledScheduledJobError extends Error {
	constructor(public readonly causeError: unknown) {
		super("Scheduled job failure already handled");
		this.name = "HandledScheduledJobError";
	}
}

export interface CronSchedulerConfig {
	store: CronJobStore;
	runner: Runner;
	cronAgent?: AgentConfig;
	providers: Partial<Record<"telegram", Provider>>;
	tickMs?: number;
	onScriptHandoff?: (message: Message) => Promise<void>;
}

export class CronScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly config: CronSchedulerConfig) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.config.tickMs ?? DEFAULT_TICK_MS);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async tick(now = new Date()): Promise<void> {
		const dueJobs = this.config.store.claimDueJobs(now);
		for (const job of dueJobs) {
			await this.executeClaimedJob(job, now);
		}
	}

	async runNow(jobId: string, now = new Date()): Promise<void> {
		const job = this.config.store.claimJobNow(jobId, now);
		if (!job) {
			throw new Error(`Job not found: ${jobId}`);
		}
		await this.executeClaimedJob(job, now);
	}

	private async executeClaimedJob(job: CronJob, now: Date): Promise<void> {
		try {
			if (job.kind === "reminder") {
				await this.executeReminderJob(job, now);
				return;
			}
			if (job.kind === "script") {
				await this.executeScriptJob(job, now);
				return;
			}
			await this.executeAgentJob(job, now);
		} catch (error) {
			if (error instanceof HandledScheduledJobError) {
				return;
			}
			const provider = this.config.providers.telegram;
			const message = error instanceof Error ? error.message : String(error);
			let outputPath: string | undefined;
			if (job.kind === "agent" || job.kind === "script") {
				outputPath = this.config.store.writeRunOutput(job.id, now, {
					kind: job.kind,
					prompt: job.prompt,
					command: job.command,
					error: message,
					failedAt: now.toISOString(),
				});
			}
			this.config.store.recordRunFailure(job.id, message, now, outputPath);
			if (provider && (job.kind === "agent" || job.kind === "script")) {
				await provider.send({
					chatId: job.delivery.chatId,
					text: this.buildScheduledJobFailureText(job, error),
				});
			}
		}
	}

	private async executeReminderJob(job: CronJob, now: Date): Promise<void> {
		const provider = this.requireTelegramProvider();
		const deliveredText = job.message ?? "";
		await provider.send({
			chatId: job.delivery.chatId,
			text: deliveredText,
		});
		this.appendDeliveredResult(job, deliveredText);
		const outputPath = this.config.store.writeRunOutput(job.id, now, {
			kind: job.kind,
			message: deliveredText,
			deliveredAt: now.toISOString(),
		});
		this.config.store.recordRunSuccess(job.id, { lastStatus: "sent reminder", outputPath }, now);
	}

	private async executeScriptJob(job: CronJob, now: Date): Promise<void> {
		const command = job.command;
		if (!command) {
			throw new Error(`Script job ${job.id} has no command`);
		}

		let stdout: string;
		try {
			stdout = execSync(command, {
				encoding: "utf-8",
				timeout: 60_000,
				env: { ...process.env, HOME: process.env.HOME ?? "/root" },
			}).trim();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const outputPath = this.config.store.writeRunOutput(job.id, now, {
				kind: job.kind,
				command,
				error: message,
				failedAt: now.toISOString(),
			});
			this.config.store.recordRunFailure(job.id, message, now, outputPath);
			const provider = this.requireTelegramProvider();
			await provider.send({
				chatId: job.delivery.chatId,
				text: this.buildScheduledJobFailureText(job, error),
			});
			throw new HandledScheduledJobError(error);
		}

		if (!stdout) {
			const outputPath = this.config.store.writeRunOutput(job.id, now, {
				kind: job.kind,
				command,
				stdout: "(empty)",
				deliveredAt: now.toISOString(),
			});
			this.config.store.recordRunSuccess(
				job.id,
				{ lastStatus: "script returned empty output", outputPath },
				now,
			);
			return;
		}

		const contextPrompt = job.prompt
			? `[Scheduled script "${job.name}" output — ${job.prompt}]\n\n${stdout}`
			: `[Scheduled script "${job.name}" output]\n\n${stdout}`;
		const handoffMessage = this.buildScriptHandoffMessage(job, now, contextPrompt);
		await this.config.onScriptHandoff?.(handoffMessage);

		const outputPath = this.config.store.writeRunOutput(job.id, now, {
			kind: job.kind,
			command,
			stdout,
			contextPrompt,
			deliveredAt: now.toISOString(),
		});
		this.config.store.recordRunSuccess(
			job.id,
			{ lastStatus: "script handoff delivered", outputPath },
			now,
		);
	}

	private buildScriptHandoffMessage(job: CronJob, now: Date, text: string): Message {
		const contextKey = job.delivery.contextKey;
		if (!contextKey) {
			throw new Error(`Script job ${job.id} has no delivery context key`);
		}
		if (contextKey.includes(":contact:")) {
			const senderId = contextKey.split(":contact:")[1] ?? job.delivery.chatId;
			return {
				id: `cron-script-${job.id}-${Date.now()}`,
				chatId: job.delivery.chatId,
				senderId,
				senderName: "Pion scheduler",
				text,
				isGroup: false,
				provider: "telegram",
				timestamp: now,
				raw: { cronJobId: job.id, kind: "script" },
			};
		}
		if (contextKey.includes(":chat:")) {
			const chatId = contextKey.split(":chat:")[1] ?? job.delivery.chatId;
			return {
				id: `cron-script-${job.id}-${Date.now()}`,
				chatId,
				senderId: `cronjob:${job.id}`,
				senderName: "Pion scheduler",
				text,
				isGroup: true,
				provider: "telegram",
				timestamp: now,
				raw: { cronJobId: job.id, kind: "script" },
			};
		}
		throw new Error(`Unsupported delivery context key for script job: ${contextKey}`);
	}

	private async executeAgentJob(job: CronJob, now: Date): Promise<void> {
		const provider = this.requireTelegramProvider();
		const agentConfig = this.resolveAgentConfig(job);
		const sentBlocks: string[] = [];
		const runStamp = now.toISOString().replace(/[:.]/g, "-");
		const workspace = agentConfig.workspace;
		let result: Awaited<ReturnType<Runner["process"]>>;
		try {
			result = await this.config.runner.process(
				{
					id: `cron-${job.id}-${runStamp}`,
					chatId: job.delivery.chatId,
					senderId: `cronjob:${job.id}`,
					senderName: "Pion scheduler",
					text: job.prompt ?? "",
					isGroup: false,
					provider: "telegram",
					timestamp: now,
					raw: { cronJobId: job.id },
				},
				{
					agentConfig,
					contextKey: `cron:${job.id}:${runStamp}`,
					customTools: createTelegramTools(provider as never, job.delivery.chatId, workspace),
				},
				{
					onTextBlock: (text) => {
						sentBlocks.push(text);
					},
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const outputPath = this.config.store.writeRunOutput(job.id, now, {
				kind: job.kind,
				prompt: job.prompt,
				responseBlocks: sentBlocks,
				error: message,
				failedAt: now.toISOString(),
			});
			this.config.store.recordRunFailure(job.id, message, now, outputPath);
			await provider.send({
				chatId: job.delivery.chatId,
				text: this.buildScheduledJobFailureText(job, error),
			});
			throw new HandledScheduledJobError(error);
		}
		const deliveredText = (sentBlocks.at(-1) ?? result.response ?? "").trim();
		if (deliveredText) {
			await provider.send({ chatId: job.delivery.chatId, text: deliveredText });
			this.appendDeliveredResult(job, deliveredText, agentConfig.cwd ?? agentConfig.workspace);
		}
		const outputPath = this.config.store.writeRunOutput(job.id, now, {
			kind: job.kind,
			prompt: job.prompt,
			responseBlocks: sentBlocks,
			deliveredText,
			deliveredAt: now.toISOString(),
		});
		this.config.store.recordRunSuccess(
			job.id,
			{ lastStatus: "sent agent response", outputPath },
			now,
		);
	}

	private resolveAgentConfig(job: CronJob): AgentConfig {
		const configured = this.config.cronAgent;
		if (!configured) {
			throw new Error("Scheduled agent jobs require cron.agent to be configured.");
		}
		return {
			...configured,
			skills: job.skills,
			systemPrompt: configured.systemPrompt
				? `${configured.systemPrompt}\n\n---\n\n${CRON_AGENT_NOTE}`
				: CRON_AGENT_NOTE,
		};
	}

	private buildScheduledJobFailureText(job: CronJob, error: unknown): string {
		return `Scheduled job "${job.name}" failed: ${getUserFacingErrorMessage(error)}`;
	}

	private appendDeliveredResult(job: CronJob, text: string, cwd?: string): void {
		if (!job.delivery.contextKey) {
			return;
		}
		this.config.runner.appendAssistantMessage(
			job.delivery.contextKey,
			`[Scheduled job result delivered]\n\n${text}`,
			cwd,
		);
	}

	private requireTelegramProvider(): Provider {
		const provider = this.config.providers.telegram;
		if (!provider) {
			throw new Error("Telegram provider is required for scheduled jobs");
		}
		return provider;
	}
}
