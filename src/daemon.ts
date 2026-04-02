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
import type { Config } from "./config/schema.js";
import { Commands } from "./core/commands.js";
import { Compactor } from "./core/compactor.js";
import { MessageDebouncer, mergeMessages } from "./core/debouncer.js";
import { expandTilde, homeDir } from "./core/paths.js";
import {
	buildAffectedChatRecoveryMessage,
	buildStartupRecoveryMessage,
	dedupeRecoveryTargets,
} from "./core/recovery.js";
import { Router } from "./core/router.js";
import { Runner, UserFacingError } from "./core/runner.js";
import {
	createMessageReceivedRuntimeEvent,
	RuntimeEventBus,
	type PionRuntimeEventInput,
} from "./core/runtime-events.js";
import { DaemonRuntimeState, type StartupRecoveryInfo } from "./core/runtime-state.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTelegramTools } from "./providers/telegram-tools.js";
import { TelegramProvider } from "./providers/telegram.js";
import type { Message, Provider } from "./providers/types.js";
import { WhatsAppProvider } from "./providers/whatsapp.js";

const DEFAULT_DEBOUNCE_MS = 5000;

class Daemon {
	private config: Config;
	private router: Router;
	private runner: Runner;
	private commands: Commands;
	private compactor: Compactor;
	private debouncer: MessageDebouncer;
	private debounceMs: number;
	private runtimeState: DaemonRuntimeState;
	private runtimeEvents: RuntimeEventBus;
	private recoveryInfo: StartupRecoveryInfo | null = null;
	private providers: Provider[] = [];
	private telegramProvider: TelegramProvider | null = null;
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
		this.runner = new Runner({
			dataDir: config.dataDir,
			skillsDir: config.skillsDir,
			authPath: config.authPath,
			runtimeEventBus: this.runtimeEvents,
		});
		this.commands = new Commands();
		this.compactor = new Compactor({ authPath: config.authPath });
		this.debouncer = new MessageDebouncer({
			timeoutMs: this.debounceMs,
			onFlush: (contextKey, messages) => this.processMessages(contextKey, messages),
		});
		this.runtimeState = new DaemonRuntimeState(dataDir);
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

		// Start Telegram if configured
		if (this.config.telegram?.botToken) {
			const telegram = new TelegramProvider({
				botToken: this.config.telegram.botToken,
			});
			telegram.onMessage((msg) => this.handleMessage(msg));
			await telegram.start();
			this.providers.push(telegram);
			this.telegramProvider = telegram;

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

		// Start WhatsApp if configured
		if (this.config.whatsapp) {
			const authDir = this.config.whatsapp.sessionDir
				? expandTilde(this.config.whatsapp.sessionDir)
				: `${homeDir()}/.pion/whatsapp-auth`;

			// Check if paired (creds.json exists)
			const credsFile = `${authDir}/creds.json`;
			if (!existsSync(credsFile)) {
				console.log("⚠ WhatsApp not paired. Run: bun run whatsapp:pair");
			} else {
				const whatsapp = new WhatsAppProvider({
					authDir,
					printQRInTerminal: false, // Don't print QR in daemon
					allowDMs: this.config.whatsapp.allowDMs,
					allowGroups: this.config.whatsapp.allowGroups,
				});
				whatsapp.onMessage((msg) => this.handleMessage(msg));

				console.log("📱 Connecting to WhatsApp...");
				try {
					await whatsapp.start();
					this.providers.push(whatsapp);

					const dmCount = this.config.whatsapp.allowDMs?.length ?? 0;
					const groupCount = this.config.whatsapp.allowGroups?.length ?? 0;
					console.log(`✓ WhatsApp connected (${dmCount} DMs, ${groupCount} groups allowed)`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : "Unknown error";
					console.error(`✗ WhatsApp failed to connect: ${msg}`);
					console.log("  Try re-pairing: bun run whatsapp:pair");
				}
			}
		}

		if (this.recoveryInfo?.recovered) {
			await this.notifyRecoveryTargets();
		}

		console.log(`\n✓ Daemon running with ${this.providers.length} provider(s)`);
		console.log("  Press Ctrl+C to stop\n");
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
				route.contextKey,
				message.chatId,
				provider,
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
		this.emitRuntimeEvent({
			source: "pion",
			contextKey,
			type: "runtime_processing_start",
			agentName,
			provider: message.provider,
			chatId: message.chatId,
			messageId: message.id,
		});

		let typingInterval: ReturnType<typeof setInterval> | null = null;

		try {
			if (provider.sendTyping) {
				await provider.sendTyping(message.chatId);
			}

			// Check: were we superseded during sendTyping?
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

			// Typing indicator refresh (Telegram typing lasts ~5s)
			typingInterval = setInterval(async () => {
				if (provider.sendTyping && !this.shuttingDown) {
					await provider.sendTyping(message.chatId).catch(() => {});
				}
			}, 4000);

			// Create provider-specific tools
			const customTools =
				message.provider === "telegram" && this.telegramProvider
					? createTelegramTools(
							this.telegramProvider,
							message.chatId,
							agent.workspace ? expandTilde(agent.workspace) : "",
						)
					: [];

			// Check again: were we superseded during tool setup?
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

			// Track messages sent so first one gets replyTo
			const pendingSends: Promise<void>[] = [];
			let messagesSent = 0;

			// Process with agent — onMessage fires for each complete text block
			// (text before tool calls, between tool calls, and final text)
			const isCancelled = () => !this.isCurrentGeneration(contextKey, gen);
			const result = await this.runner.process(message, {
				agentConfig: agent,
				contextKey,
				customTools,
			}, {
				onTextBlock: (text) => {
					// Suppress output if this run was superseded
					if (isCancelled()) return;

					const msgNum = messagesSent + 1;
					console.log(
						`   📤 Message ${msgNum}: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`,
					);
					const replyTo = msgNum === 1 ? message.id : undefined;
					const sendPromise = provider
						.send({
							chatId: message.chatId,
							text,
							replyTo,
						})
						.then(() => {
							this.emitRuntimeEvent({
								source: "pion",
								contextKey,
								type: "runtime_output_sent",
								provider: message.provider,
								chatId: message.chatId,
								replyTo,
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
			});

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
				await provider.send({
					chatId: message.chatId,
					text: warning,
				});
			}

			if (messagesSent > 0) {
				console.log(`   ✓ Sent ${messagesSent} message(s)`);
			} else if (result.response) {
				// Fallback: if no messages were sent via callback, send full response
				await provider.send({
					chatId: message.chatId,
					text: result.response,
					replyTo: message.id,
				});
				this.emitRuntimeEvent({
					source: "pion",
					contextKey,
					type: "runtime_output_sent",
					provider: message.provider,
					chatId: message.chatId,
					replyTo: message.id,
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
			const errorText =
				error instanceof UserFacingError
					? error.userMessage
					: "Sorry, I encountered an error. Please try again.";

			// Send error message back
			await provider.send({
				chatId: message.chatId,
				text: errorText,
				replyTo: message.id,
			});
			this.emitRuntimeEvent({
				source: "pion",
				contextKey,
				type: "runtime_output_sent",
				provider: message.provider,
				chatId: message.chatId,
				replyTo: message.id,
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
		reason: "stop" | "new" | "compact",
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
		contextKey: string,
		chatId: string,
		provider: Provider,
		cancelledCount = 0,
	): Promise<void> {
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
					// Supersede active work before compacting
					await this.supersedeActiveWork(contextKey, "compact");

					const sessionFile = this.runner.getSessionFile(contextKey);

					// Show typing while summarizing
					if (provider.sendTyping) {
						await provider.sendTyping(chatId);
					}

					// Summarize with Haiku
					console.log("   ⏳ Summarizing with Haiku...");
					const summary = await this.compactor.summarize(sessionFile, cmd.args || undefined);

					// Prime new session with summary
					this.runner.primeSessionWithSummary(contextKey, summary);

					await provider.send({
						chatId,
						text: `✓ Session compacted.\n\n<b>Summary preserved:</b>\n${summary}`,
					});
					console.log("   ✓ Session compacted");
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

		// Stop all providers
		for (const provider of this.providers) {
			try {
				await provider.stop();
				console.log(`   ✓ ${provider.type} stopped`);
			} catch (error) {
				console.error(`   ✗ ${provider.type} stop failed:`, error);
			}
		}

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
