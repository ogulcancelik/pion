#!/usr/bin/env bun

/**
 * Pion Daemon
 *
 * Long-running process that handles messaging.
 *
 * Usage:
 *   bun run src/daemon.ts
 *
 * Signals:
 *   SIGTERM/SIGINT - Graceful shutdown
 *   SIGHUP - Reload config (TODO)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config/loader.js";
import type { Config, IsolationMode } from "./config/schema.js";
import { Commands } from "./core/commands.js";
import { shouldAutoCompact } from "./core/compactor.js";
import { CronJobStore } from "./core/cron-jobs.js";
import { CronScheduler } from "./core/cron-scheduler.js";
import { buildCronPromptBlock, createCronTools } from "./core/cron-tools.js";
import { MessageDebouncer, mergeMessages } from "./core/debouncer.js";
import { getOutputDeliveryTarget } from "./core/output-routing.js";
import { expandTilde, homeDir } from "./core/paths.js";
import {
	buildAffectedChatRecoveryMessage,
	buildStartupRecoveryMessage,
	dedupeRecoveryTargets,
} from "./core/recovery.js";
import { RepoUpdateChecker, formatRepoUpdateStatus } from "./core/repo-update.js";
import { Router } from "./core/router.js";
import { Runner, getUserFacingErrorMessage } from "./core/runner.js";
import {
	type PionRuntimeEventInput,
	RuntimeEventBus,
	createMessageReceivedRuntimeEvent,
} from "./core/runtime-events.js";
import { RuntimeInspectorServer } from "./core/runtime-inspector-ipc.js";
import { RuntimeInspectorStore } from "./core/runtime-inspector.js";
import { DaemonRuntimeState, type StartupRecoveryInfo } from "./core/runtime-state.js";
import { buildSettingsText } from "./core/settings.js";
import { loadSkills } from "./core/skills.js";
import { ensureWorkspace } from "./core/workspace.js";
import { TelegramStatusSink } from "./providers/telegram-status.js";
import { createTelegramTools } from "./providers/telegram-tools.js";
import { TelegramProvider } from "./providers/telegram.js";
import type { ActionMessage, Message, Provider } from "./providers/types.js";
import { sendTypingBestEffort } from "./providers/typing.js";

const DEFAULT_DEBOUNCE_MS = 5000;

class Daemon {
	private config: Config;
	private router: Router;
	private runner: Runner;
	private commands: Commands;
	private debouncer: MessageDebouncer;
	private debounceMs: number;
	private runtimeState: DaemonRuntimeState;
	private runtimeEvents: RuntimeEventBus;
	private updateChecker: RepoUpdateChecker;
	private runtimeInspector: RuntimeInspectorStore;
	private runtimeInspectorServer: RuntimeInspectorServer;
	private cronJobStore: CronJobStore;
	private cronScheduler: CronScheduler;
	private recoveryInfo: StartupRecoveryInfo | null = null;
	private providers: Provider[] = [];
	private telegramProvider: TelegramProvider | null = null;
	private detachTelegramStatusSink?: () => void;
	private shuttingDown = false;
	/**
	 * Generation counter per context. Incremented when a run is superseded
	 * (new message arrives or /stop). Each run captures its generation at start
	 * and checks it at async boundaries — if it changed, the run was superseded
	 * and should bail. Avoids the "who clears the flag?" problem of a boolean.
	 */
	private contextGeneration = new Map<string, number>();
	/** Tracks contexts currently processing (set before isStreaming becomes true) */
	private processingContexts: Set<string> = new Set();
	/** Maps context keys to their route info for deferred processing */
	private routeCache = new Map<
		string,
		{
			agent: NonNullable<ReturnType<Router["route"]>["agent"]>;
			agentName: string;
			provider: Provider;
		}
	>();

	constructor(config: Config) {
		this.config = config;
		this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.router = new Router(config);
		const dataDir = config.dataDir ? expandTilde(config.dataDir) : join(homeDir(), ".pion");
		this.runtimeEvents = new RuntimeEventBus(dataDir);
		this.runtimeInspector = new RuntimeInspectorStore(dataDir);
		this.updateChecker = new RepoUpdateChecker({
			stateDir: dataDir,
			enabled: config.updateCheck?.enabled,
			repoPath: config.updateCheck?.repoPath,
		});
		this.runtimeInspectorServer = new RuntimeInspectorServer(this.runtimeInspector, dataDir);
		this.runtimeEvents.subscribe((event) => this.runtimeInspector.handleRuntimeEvent(event));
		this.cronJobStore = new CronJobStore({ dataDir });
		this.runner = new Runner({
			dataDir: config.dataDir,
			skillsDir: config.skillsDir,
			authPath: config.authPath,
			recallQueryModel: config.recallQueryModel,
			bashTimeoutSec: config.bashTimeoutSec,
			toolEnvFile: config.toolEnvFile,
			runtimeEventBus: this.runtimeEvents,
		});
		this.commands = new Commands();
		this.debouncer = new MessageDebouncer({
			timeoutMs: this.debounceMs,
			onFlush: (contextKey, messages) => this.processMessages(contextKey, messages),
		});
		this.runtimeState = new DaemonRuntimeState(dataDir);
		this.cronScheduler = new CronScheduler({
			store: this.cronJobStore,
			runner: this.runner,
			cronAgent: this.config.cron?.agent,
			providers: {},
			onScriptHandoff: async (msg) => this.handleMessage(msg),
		});
	}

	/** Increment and return the new generation for a context. */
	private nextGeneration(contextKey: string): number {
		const gen = (this.contextGeneration.get(contextKey) ?? 0) + 1;
		this.contextGeneration.set(contextKey, gen);
		return gen;
	}

	/** Check if a generation is still current (not superseded). */
	private isCurrentGeneration(contextKey: string, gen: number): boolean {
		return (this.contextGeneration.get(contextKey) ?? 0) === gen;
	}

	private emitRuntimeEvent(event: PionRuntimeEventInput): void {
		this.runtimeEvents.emit(event);
	}

	async start(): Promise<void> {
		console.log("🔮 Pion daemon starting...\n");
		this.recoveryInfo = this.runtimeState.markStartup();
		if (this.recoveryInfo.recovered) {
			console.warn(
				`⚠ Previous run ended unexpectedly (${this.recoveryInfo.interruptedContexts.length} interrupted context(s))`,
			);
		}

		// Ensure agent workspaces exist
		for (const [name, agent] of Object.entries(this.config.agents)) {
			if (agent.workspace) {
				ensureWorkspace(agent.workspace);
				console.log(`✓ Workspace ready: ${name}`);
			}
		}
		if (this.config.cron?.agent?.workspace) {
			ensureWorkspace(this.config.cron.agent.workspace);
			console.log("✓ Workspace ready: cron.agent");
		}

		await this.runtimeInspectorServer.start();
		console.log("✓ Runtime inspector socket ready");

		// Start Telegram if configured
		if (this.config.telegram?.botToken) {
			const telegram = new TelegramProvider({
				botToken: this.config.telegram.botToken,
			});
			telegram.onMessage((msg) => this.handleMessage(msg));
			telegram.onAction?.((action) => this.handleAction(action));
			await telegram.start();
			this.providers.push(telegram);
			this.telegramProvider = telegram;
			this.cronScheduler = new CronScheduler({
				store: this.cronJobStore,
				runner: this.runner,
				cronAgent: this.config.cron?.agent,
				providers: { telegram },
				onScriptHandoff: async (msg) => this.handleMessage(msg),
			});
			this.detachTelegramStatusSink = new TelegramStatusSink(telegram, {
				mode: this.config.telegram.status?.mode,
				clearOnComplete: this.config.telegram.status?.clearOnComplete,
			}).attach(this.runtimeEvents);

			// Send startup notification if configured
			if (this.config.telegram.startupNotify) {
				const startupText = this.recoveryInfo?.recovered
					? buildStartupRecoveryMessage({
							interruptedCount: this.recoveryInfo.interruptedContexts.length,
							lastFatalError: this.recoveryInfo.previousState?.lastFatalError,
							lastHeartbeatAt: this.recoveryInfo.previousState?.lastHeartbeatAt,
						})
					: "🔮 Pion started.";
				await telegram.send({
					chatId: this.config.telegram.startupNotify,
					text: startupText,
				});
				console.log("✓ Startup notification sent");
			}
		}

		this.cronScheduler.start();
		console.log("✓ Cron scheduler started");

		if (this.recoveryInfo?.recovered) {
			await this.notifyRecoveryTargets();
		}

		console.log(`\n✓ Daemon running with ${this.providers.length} provider(s)`);
		console.log("  Press Ctrl+C to stop\n");
	}

	private async handleAction(action: ActionMessage): Promise<void> {
		if (this.shuttingDown) return;

		const provider = this.getProvider(action.provider);
		if (!provider) return;

		const cmd = this.commands.fromAction(action);
		if (!cmd) {
			console.log(`   → Ignored action: ${action.actionId}`);
			return;
		}

		const route = this.router.routeAction(action);
		if (!route.agent) {
			console.log("   → Ignored action (no matching agent)");
			return;
		}

		this.runtimeInspector.registerContext({
			agentName: route.agentName ?? "unknown",
			contextKey: route.contextKey,
			provider: action.provider,
			chatId: action.chatId,
		});

		console.log(`   → Action: ${action.actionId}`);
		const cancelledMessages = this.debouncer.cancel(route.contextKey);
		if (cancelledMessages.length > 0) {
			this.routeCache.delete(route.contextKey);
			console.log(`   → Cancelled ${cancelledMessages.length} buffered message(s)`);
		}

		await this.handleCommand(
			cmd,
			{
				contextKey: route.contextKey,
				isolation: route.isolation,
				chatId: action.chatId,
				provider,
				agentName: route.agentName,
				agent: route.agent,
			},
			cancelledMessages.length,
		);
	}

	private async handleMessage(message: Message): Promise<void> {
		if (this.shuttingDown) return;

		const sender = message.senderName || message.senderId;
		console.log(
			`📨 ${sender}: ${message.text.slice(0, 50)}${message.text.length > 50 ? "..." : ""}`,
		);

		// Route the message (needed for contextKey even for commands)
		const route = this.router.route(message);
		this.emitRuntimeEvent(createMessageReceivedRuntimeEvent(route.contextKey, message));

		if (!route.agent) {
			console.log("   → Ignored (no matching agent)");
			return;
		}

		const provider = this.getProvider(message.provider);
		if (!provider) return;

		this.runtimeInspector.registerContext({
			agentName: route.agentName ?? "unknown",
			contextKey: route.contextKey,
			provider: message.provider,
			chatId: message.chatId,
		});

		// Check for commands first — commands bypass debounce entirely
		const cmd = this.commands.parse(message.text);
		if (cmd) {
			console.log(`   → Command: /${cmd.command}${cmd.args ? ` ${cmd.args}` : ""}`);
			// Cancel any pending debounce buffer and its cached route
			const cancelledMessages = this.debouncer.cancel(route.contextKey);
			if (cancelledMessages.length > 0) {
				this.routeCache.delete(route.contextKey);
				console.log(`   → Cancelled ${cancelledMessages.length} buffered message(s)`);
			}
			await this.handleCommand(
				cmd,
				{
					contextKey: route.contextKey,
					isolation: route.isolation,
					chatId: message.chatId,
					provider,
					agentName: route.agentName,
					agent: route.agent,
				},
				cancelledMessages.length,
			);
			return;
		}

		// Supersede any in-flight work: increment generation so old runs bail
		if (
			this.runner.isStreaming(route.contextKey) ||
			this.processingContexts.has(route.contextKey)
		) {
			console.log("   → Superseding current response (new message received)");
			this.emitRuntimeEvent({
				source: "pion",
				contextKey: route.contextKey,
				type: "runtime_superseded",
				reason: "new_message",
			});
			this.nextGeneration(route.contextKey);
			// Also try to abort the runner if it's streaming (best-effort)
			await this.runner.abort(route.contextKey).catch(() => {});
		}

		// Cache route info for when the debouncer flushes
		this.routeCache.set(route.contextKey, {
			agent: route.agent,
			agentName: route.agentName ?? "unknown",
			provider,
		});

		// Debounce disabled (debounceMs: 0) — process immediately
		if (this.debounceMs === 0) {
			console.log(`   → ${route.agentName} (immediate)`);
			this.processMessages(route.contextKey, [message]);
			return;
		}

		// Buffer the message — debouncer will call processMessages after quiet period
		// NOTE: In group chats with per-chat isolation, messages from different senders
		// within the debounce window will be merged. Acceptable tradeoff for now.
		console.log(`   → Buffered (${route.agentName}, debounce ${this.debounceMs}ms)`);
		this.debouncer.add(route.contextKey, message);
		this.emitRuntimeEvent({
			source: "pion",
			contextKey: route.contextKey,
			type: "runtime_message_buffered",
			messageCount: this.debouncer.getPendingCount(route.contextKey),
		});
	}

	/**
	 * Process a batch of debounced messages for a context.
	 * Called by the debouncer when the quiet period expires, or directly
	 * when debouncing is disabled (debounceMs: 0).
	 */
	private async processMessages(contextKey: string, messages: Message[]): Promise<void> {
		if (this.shuttingDown) return;

		// Read and delete route cache immediately — before any await.
		// This prevents a later run's finally from deleting a newer entry.
		const cached = this.routeCache.get(contextKey);
		this.routeCache.delete(contextKey);
		if (!cached) {
			console.error(`   ✗ No cached route for ${contextKey}`);
			return;
		}

		const { agent, agentName, provider } = cached;

		// Merge all buffered messages into one
		const message = mergeMessages(messages);
		let runnerMessage = message;

		if (messages.length > 1) {
			console.log(`   📦 Merged ${messages.length} messages for ${agentName}`);
			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_messages_merged",
				messageCount: messages.length,
				messageIds: messages.map((entry) => entry.id),
			});
		}
		console.log(`   → Processing: ${agentName}`);

		// Capture the current generation. If it changes during processing,
		// this run has been superseded by a newer message or /stop.
		const gen = this.contextGeneration.get(contextKey) ?? 0;

		// Mark context as busy immediately (before async init sets isStreaming)
		this.processingContexts.add(contextKey);
		this.runtimeState.trackContextStart({
			contextKey,
			provider: message.provider,
			chatId: message.chatId,
			startedAt: new Date().toISOString(),
			messageId: message.id,
			messagePreview: message.text.slice(0, 200),
		});

		let typingInterval: ReturnType<typeof setInterval> | null = null;

		try {
			await sendTypingBestEffort(provider, message.chatId);

			try {
				const updateNote = await this.updateChecker.getAutomaticSystemNote(message.timestamp);
				if (updateNote) {
					runnerMessage = {
						...message,
						text: `${updateNote}\n\n${message.text}`,
					};
					console.log("   ℹ️ Injected repo update note into user turn");
				}
			} catch (error) {
				console.warn(
					"   ⚠️ Repo update check failed:",
					error instanceof Error ? error.message : error,
				);
			}

			if (!this.isCurrentGeneration(contextKey, gen)) {
				console.log("   ⏹️ Superseded before processing");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_processing_complete",
					outcome: "superseded",
					messagesSent: 0,
					responseLength: 0,
				});
				return;
			}

			typingInterval = setInterval(async () => {
				if (provider.sendTyping && !this.shuttingDown) {
					await provider.sendTyping(message.chatId).catch(() => {});
				}
			}, 4000);

			const customTools =
				message.provider === "telegram" && this.telegramProvider
					? [
							...createTelegramTools(
								this.telegramProvider,
								message.chatId,
								agent.workspace ? expandTilde(agent.workspace) : "",
							),
							...createCronTools({
								store: this.cronJobStore,
								cronAgentConfigured: !!this.config.cron?.agent,
								availableSkills: this.getAvailableSkillNames(),
								chatId: message.chatId,
								contextKey,
								provider: "telegram",
								onRunNow: async (jobId) => {
									await this.cronScheduler.runNow(jobId);
								},
							}),
						]
					: [];
			const agentConfig = this.buildForegroundAgentConfig(agent);
			const isCancelled = () => !this.isCurrentGeneration(contextKey, gen);

			if (!this.isCurrentGeneration(contextKey, gen)) {
				console.log("   ⏹️ Superseded before processing");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_processing_complete",
					outcome: "superseded",
					messagesSent: 0,
					responseLength: 0,
				});
				return;
			}

			const contextUsage = await this.runner.getContextUsage({
				agentConfig,
				contextKey,
				customTools,
			});
			if (shouldAutoCompact(contextUsage?.percent)) {
				console.log(`   🧠 Auto-compacting at ${Math.round(contextUsage?.percent ?? 0)}%`);
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_compaction_start",
					provider: message.provider,
					chatId: message.chatId,
					trigger: "automatic",
				});
				await this.runner.compact(
					{
						agentConfig,
						contextKey,
						customTools,
					},
					{
						isCancelled,
						pendingUserMessage: message.text,
					},
				);
			}

			if (!this.isCurrentGeneration(contextKey, gen)) {
				console.log("   ⏹️ Superseded before processing");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_processing_complete",
					outcome: "superseded",
					messagesSent: 0,
					responseLength: 0,
				});
				return;
			}

			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_processing_start",
				agentName,
				provider: message.provider,
				chatId: message.chatId,
				messageId: message.id,
			});

			const pendingSends: Promise<void>[] = [];
			let messagesSent = 0;
			const result = await this.runner.process(
				runnerMessage,
				{
					agentConfig,
					contextKey,
					customTools,
				},
				{
					onTextBlock: (text) => {
						// Suppress output if this run was superseded
						if (isCancelled()) return;

						const msgNum = messagesSent + 1;
						console.log(
							`   📤 Message ${msgNum}: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`,
						);
						const deliveryTarget = getOutputDeliveryTarget("stream", message.id);
						const sendPromise = provider
							.send({
								chatId: message.chatId,
								text,
								replyTo: deliveryTarget.replyTo,
							})
							.then(() => {
								this.emitRuntimeEvent({
									source: "pion",
									contextKey,
									type: "runtime_output_sent",
									provider: message.provider,
									chatId: message.chatId,
									replyTo: deliveryTarget.replyTo,
									text,
								});
							})
							.catch((err) => {
								console.error(`   ✗ Message ${msgNum} failed:`, err);
							});
						pendingSends.push(sendPromise);
						messagesSent++;
					},
					isCancelled,
				},
			);

			await Promise.all(pendingSends);

			// Don't send warnings/fallback if superseded
			if (!this.isCurrentGeneration(contextKey, gen)) {
				console.log("   ⏹️ Superseded (output suppressed)");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_processing_complete",
					outcome: "superseded",
					messagesSent,
					responseLength: result.response.length,
				});
				return;
			}

			// Send warnings (if any)
			for (const warning of result.warnings) {
				console.log("   ⚠️ Sending warning");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_warning_emitted",
					warning,
				});
				const deliveryTarget = getOutputDeliveryTarget("warning", message.id);
				await provider.send({
					chatId: message.chatId,
					text: warning,
					replyTo: deliveryTarget.replyTo,
				});
			}

			if (messagesSent > 0) {
				console.log(`   ✓ Sent ${messagesSent} message(s)`);
			} else if (result.response) {
				// Fallback: if no messages were sent via callback, send full response
				const deliveryTarget = getOutputDeliveryTarget("fallback", message.id);
				await provider.send({
					chatId: message.chatId,
					text: result.response,
					replyTo: deliveryTarget.replyTo,
				});
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_output_sent",
					provider: message.provider,
					chatId: message.chatId,
					replyTo: deliveryTarget.replyTo,
					text: result.response,
				});
				messagesSent = 1;
				console.log(`   ✓ Sent (${result.response.length} chars)`);
			}

			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_processing_complete",
				outcome: "completed",
				messagesSent,
				responseLength: result.response.length,
			});
		} catch (error) {
			// Don't send error messages for superseded runs
			if (!this.isCurrentGeneration(contextKey, gen)) {
				console.log("   ⏹️ Superseded (error suppressed)");
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_processing_complete",
					outcome: "superseded",
					messagesSent: 0,
					responseLength: 0,
				});
				return;
			}

			console.error("   ✗ Error:", error instanceof Error ? error.message : error);
			const errorText = getUserFacingErrorMessage(error);

			// Send error message back
			const deliveryTarget = getOutputDeliveryTarget("error", message.id);
			await provider.send({
				chatId: message.chatId,
				text: errorText,
				replyTo: deliveryTarget.replyTo,
			});
			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_output_sent",
				provider: message.provider,
				chatId: message.chatId,
				replyTo: deliveryTarget.replyTo,
				text: errorText,
			});
			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_processing_complete",
				outcome: "failed",
				messagesSent: 1,
				responseLength: errorText.length,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (typingInterval) clearInterval(typingInterval);
			this.processingContexts.delete(contextKey);
			this.runtimeState.trackContextFinish(contextKey);
		}
	}

	/**
	 * Supersede any active processing for a context.
	 * Bumps generation so in-flight work bails, and aborts the runner.
	 * Returns true if something was actively running.
	 */
	private async supersedeActiveWork(
		contextKey: string,
		reason: "stop" | "new" | "compact" | "restart",
	): Promise<boolean> {
		const wasBusy = this.runner.isStreaming(contextKey) || this.processingContexts.has(contextKey);
		if (wasBusy) {
			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_superseded",
				reason,
			});
			this.nextGeneration(contextKey);
			await this.runner.abort(contextKey).catch(() => {});
		}
		return wasBusy;
	}

	private async handleCommand(
		cmd: { command: string; args: string },
		context: {
			contextKey: string;
			isolation: IsolationMode;
			chatId: string;
			provider: Provider;
			agentName: string | null;
			agent: Config["agents"][string] | null;
		},
		cancelledCount = 0,
	): Promise<void> {
		const { contextKey, isolation, chatId, provider, agentName, agent } = context;
		try {
			switch (cmd.command) {
				case "new": {
					// Supersede active work before clearing session
					await this.supersedeActiveWork(contextKey, "new");
					this.runner.clearSession(contextKey);
					await provider.send({
						chatId,
						text: "✓ Session cleared. Fresh start!",
					});
					console.log("   ✓ Session cleared");
					break;
				}

				case "stop": {
					const wasBusy = await this.supersedeActiveWork(contextKey, "stop");

					if (wasBusy || cancelledCount > 0) {
						await provider.send({
							chatId,
							text: "⏹️ Stopped.",
						});
						console.log("   ✓ Aborted");
					} else {
						await provider.send({
							chatId,
							text: "Nothing running.",
						});
						console.log("   ⚠️ Nothing to abort");
					}
					break;
				}

				case "compact": {
					await this.supersedeActiveWork(contextKey, "compact");
					if (!agent) {
						await provider.send({
							chatId,
							text: "No agent configured for this context.",
						});
						break;
					}

					const sessionFile = this.runner.getSessionFile(contextKey);
					if (!existsSync(sessionFile)) {
						await provider.send({
							chatId,
							text: "Nothing to compact yet.",
						});
						console.log("   ⚠️ Nothing to compact");
						break;
					}

					this.emitRuntimeEvent({
						source: "pion",
						contextKey,
						type: "runtime_compaction_start",
						provider: provider.type,
						chatId,
						trigger: "manual",
					});

					await sendTypingBestEffort(provider, chatId);

					console.log("   ⏳ Generating hidden handoff...");
					await this.runner.compact({
						agentConfig: this.buildForegroundAgentConfig(agent),
						contextKey,
					});

					const text = "✓ Session compacted. Fresh context ready.";
					await provider.send({
						chatId,
						text,
					});
					this.emitRuntimeEvent({
						source: "pion",
						contextKey,
						type: "runtime_output_sent",
						provider: provider.type,
						chatId,
						text,
					});
					this.emitRuntimeEvent({
						source: "pion",
						contextKey,
						type: "runtime_processing_complete",
						outcome: "completed",
						messagesSent: 1,
						responseLength: text.length,
					});
					console.log("   ✓ Session compacted");
					break;
				}

				case "restart": {
					await provider.send({
						chatId,
						text: "↻ Restarting daemon...",
					});
					console.log("   ↻ Restart requested");
					await this.supersedeActiveWork(contextKey, "restart");
					setTimeout(() => {
						void this.stop().finally(() => process.exit(1));
					}, 0);
					break;
				}

				case "checkupdate": {
					const status = await this.updateChecker.checkNow();
					await provider.send({
						chatId,
						text: formatRepoUpdateStatus(status),
					});
					console.log(`   ✓ Repo update status: ${status.kind}`);
					break;
				}

				case "settings": {
					const sessionFile = this.runner.getSessionFile(contextKey);
					const hasSession = existsSync(sessionFile);
					const isBusy =
						this.runner.isStreaming(contextKey) || this.processingContexts.has(contextKey);
					const status = isBusy
						? "⚙️ processing"
						: hasSession
							? "💬 session active"
							: "🆕 no session yet";
					const contextUsage = agent
						? await this.runner.getContextUsage({
								contextKey,
								agentConfig: this.buildForegroundAgentConfig(agent),
							})
						: null;
					const settingsText = buildSettingsText({
						status,
						agentName,
						model: agent?.model,
						isolation,
						contextKey,
						contextUsage,
					});

					if (provider.type === "telegram" && this.telegramProvider) {
						await this.telegramProvider.sendControlMenu({
							chatId,
							text: settingsText,
							buttons: [
								["🆕 new session", "🧠 compact"],
								["⏹ stop", "↻ restart"],
							],
						});
					} else {
						await provider.send({
							chatId,
							text: `${settingsText}\n\nAvailable controls: /new, /compact, /stop, /checkupdate, /restart`,
						});
					}
					console.log("   ✓ Settings shown");
					break;
				}

				default:
					console.log(`   ✗ Unknown command: ${cmd.command}`);
			}
		} catch (error) {
			console.error("   ✗ Command error:", error instanceof Error ? error.message : error);
			await provider.send({
				chatId,
				text: `Failed to execute command: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	}

	private buildForegroundAgentConfig(agent: Config["agents"][string]): Config["agents"][string] {
		const cronPrompt = buildCronPromptBlock(!!this.config.cron?.agent);
		return {
			...agent,
			systemPrompt: agent.systemPrompt
				? `${agent.systemPrompt}\n\n---\n\n${cronPrompt}`
				: cronPrompt,
		};
	}

	private getAvailableSkillNames(): string[] {
		const skillsDir = this.config.skillsDir
			? expandTilde(this.config.skillsDir)
			: join(homeDir(), ".pion/skills");
		return loadSkills(skillsDir).skills.map((skill) => skill.name);
	}

	private async notifyRecoveryTargets(): Promise<void> {
		if (!this.recoveryInfo?.recovered) return;

		const targets = dedupeRecoveryTargets(this.recoveryInfo.interruptedContexts);
		if (targets.length === 0) return;

		for (const target of targets) {
			const provider = this.getProvider(target.provider);
			if (!provider) {
				console.warn(
					`⚠ Recovery notification skipped (${target.provider} unavailable for ${target.chatId})`,
				);
				continue;
			}

			try {
				await provider.send({
					chatId: target.chatId,
					text: buildAffectedChatRecoveryMessage(),
				});
				console.log(`✓ Recovery notification sent to ${target.provider}:${target.chatId}`);
			} catch (error) {
				console.error(
					`✗ Recovery notification failed for ${target.provider}:${target.chatId}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}

	private getProvider(type: string): Provider | undefined {
		return this.providers.find((p) => p.type === type);
	}

	recordFatalError(error: unknown): void {
		this.runtimeState.recordFatalError(error);
	}

	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		console.log("\n👋 Shutting down...");

		// Dispose debouncer (cancels all pending timers)
		this.debouncer.dispose();

		this.detachTelegramStatusSink?.();
		this.detachTelegramStatusSink = undefined;

		this.cronScheduler.stop();

		// Stop all providers
		for (const provider of this.providers) {
			try {
				await provider.stop();
				console.log(`   ✓ ${provider.type} stopped`);
			} catch (error) {
				console.error(`   ✗ ${provider.type} stop failed:`, error);
			}
		}

		await this.runtimeInspectorServer.stop();
		this.runtimeEvents.close();
		this.runtimeState.markShutdown();
		console.log("✓ Daemon stopped");
	}
}

// Main
async function main() {
	// Load config
	let config: Config;
	try {
		config = loadConfig();
	} catch (error) {
		console.error("Failed to load config:", error instanceof Error ? error.message : error);
		process.exit(1);
	}

	const daemon = new Daemon(config);

	// Signal handlers
	const shutdown = async () => {
		await daemon.stop();
		process.exit(0);
	};

	const crash = async (error: unknown) => {
		daemon.recordFatalError(error);
		console.error("Fatal daemon error:", error);
		process.exit(1);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("uncaughtException", (error) => {
		void crash(error);
	});
	process.on("unhandledRejection", (reason) => {
		void crash(reason);
	});

	// TODO: SIGHUP for config reload
	process.on("SIGHUP", () => {
		console.log("⟳ Config reload requested (not implemented yet)");
	});

	// Start
	try {
		await daemon.start();
	} catch (error) {
		daemon.recordFatalError(error);
		console.error("Failed to start:", error);
		process.exit(1);
	}
}

main();
