import type { AgentConfig } from "../config/schema.js";
import { createTelegramTools } from "../providers/telegram-tools.js";
import type { Provider } from "../providers/types.js";
import type { CronJob, CronJobStore } from "./cron-jobs.js";
import type { Runner } from "./runner.js";

const DEFAULT_TICK_MS = 60_000;
const CRON_AGENT_NOTE =
	"You are running as a scheduled background job. No user is present. Complete the task fully and write a final response that can be delivered directly to the configured Telegram chat.";

export interface CronSchedulerConfig {
	store: CronJobStore;
	runner: Runner;
	cronAgent?: AgentConfig;
	providers: Partial<Record<"telegram", Provider>>;
	tickMs?: number;
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
			await this.executeAgentJob(job, now);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.config.store.recordRunFailure(job.id, message, now);
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

	private async executeAgentJob(job: CronJob, now: Date): Promise<void> {
		const provider = this.requireTelegramProvider();
		const agentConfig = this.resolveAgentConfig(job);
		const sentBlocks: string[] = [];
		const runStamp = now.toISOString().replace(/[:.]/g, "-");
		const workspace = agentConfig.workspace;
		await this.config.runner.process(
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
					void provider.send({ chatId: job.delivery.chatId, text });
				},
			},
		);
		const combinedText = sentBlocks.join("\n\n").trim();
		if (combinedText) {
			this.appendDeliveredResult(job, combinedText, agentConfig.cwd ?? agentConfig.workspace);
		}
		const outputPath = this.config.store.writeRunOutput(job.id, now, {
			kind: job.kind,
			prompt: job.prompt,
			responseBlocks: sentBlocks,
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
