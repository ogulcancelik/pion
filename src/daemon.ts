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
import { loadConfig } from "./config/loader.js";
import type { Config } from "./config/schema.js";
import { Commands } from "./core/commands.js";
import { Compactor } from "./core/compactor.js";
import { expandTilde, homeDir } from "./core/paths.js";
import { Router } from "./core/router.js";
import { Runner } from "./core/runner.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTelegramTools } from "./providers/telegram-tools.js";
import { TelegramProvider } from "./providers/telegram.js";
import type { Message, Provider } from "./providers/types.js";
import { WhatsAppProvider } from "./providers/whatsapp.js";

class Daemon {
	private config: Config;
	private router: Router;
	private runner: Runner;
	private commands: Commands;
	private compactor: Compactor;
	private providers: Provider[] = [];
	private telegramProvider: TelegramProvider | null = null;
	private shuttingDown = false;

	constructor(config: Config) {
		this.config = config;
		this.router = new Router(config);
		this.runner = new Runner({ dataDir: config.dataDir, skillsDir: config.skillsDir });
		this.commands = new Commands();
		this.compactor = new Compactor();
	}

	async start(): Promise<void> {
		console.log("🔮 Pion daemon starting...\n");

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
				await telegram.send({
					chatId: this.config.telegram.startupNotify,
					text: "🔮 Pion started.",
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

		if (!route.agent) {
			console.log("   → Ignored (no matching agent)");
			return;
		}

		const provider = this.getProvider(message.provider);
		if (!provider) return;

		// Check for commands first
		const cmd = this.commands.parse(message.text);
		if (cmd) {
			console.log(`   → Command: /${cmd.command}${cmd.args ? ` ${cmd.args}` : ""}`);
			await this.handleCommand(cmd, route.contextKey, message.chatId, provider);
			return;
		}

		// Check if session is already processing - if so, steer instead
		if (this.runner.isStreaming(route.contextKey)) {
			console.log("   → Steering (session busy)");
			try {
				await this.runner.steer(route.contextKey, message.text);
				// Don't send a separate response - steering gets woven into ongoing response
			} catch (error) {
				console.error("   ✗ Steering failed:", error instanceof Error ? error.message : error);
			}
			return;
		}

		console.log(`   → ${route.agentName} (${route.isolation})`);

		try {
			if (provider.sendTyping) {
				await provider.sendTyping(message.chatId);
			}

			// Typing indicator refresh (Telegram typing lasts ~5s)
			const typingInterval = setInterval(async () => {
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
							route.agent.workspace ? expandTilde(route.agent.workspace) : "",
						)
					: [];

			// Track messages sent so first one gets replyTo
			const pendingSends: Promise<void>[] = [];
			let messagesSent = 0;

			// Process with agent — onMessage fires for each complete text block
			// (text before tool calls, between tool calls, and final text)
			const result = await this.runner.process(
				message,
				{
					agentConfig: route.agent,
					contextKey: route.contextKey,
					customTools,
				},
				(text) => {
					const msgNum = messagesSent + 1;
					console.log(`   📤 Message ${msgNum}: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);
					const sendPromise = provider
						.send({
							chatId: message.chatId,
							text,
							replyTo: msgNum === 1 ? message.id : undefined,
						})
						.then(() => {})
						.catch((err) => {
							console.error(`   ✗ Message ${msgNum} failed:`, err);
						});
					pendingSends.push(sendPromise);
					messagesSent++;
				},
			);

			await Promise.all(pendingSends);
			clearInterval(typingInterval);

			// Send warnings (if any)
			for (const warning of result.warnings) {
				console.log("   ⚠️ Sending warning");
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
				console.log(`   ✓ Sent (${result.response.length} chars)`);
			}
		} catch (error) {
			console.error("   ✗ Error:", error instanceof Error ? error.message : error);

			// Send error message back
			await provider.send({
				chatId: message.chatId,
				text: "Sorry, I encountered an error. Please try again.",
				replyTo: message.id,
			});
		}
	}

	private async handleCommand(
		cmd: { command: string; args: string },
		contextKey: string,
		chatId: string,
		provider: Provider,
	): Promise<void> {
		try {
			switch (cmd.command) {
				case "new": {
					this.runner.clearSession(contextKey);
					await provider.send({
						chatId,
						text: "✓ Session cleared. Fresh start!",
					});
					console.log("   ✓ Session cleared");
					break;
				}

				case "stop": {
					const aborted = this.runner.abort(contextKey);
					if (aborted) {
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

	private getProvider(type: string): Provider | undefined {
		return this.providers.find((p) => p.type === type);
	}

	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		console.log("\n👋 Shutting down...");

		// Stop all providers
		for (const provider of this.providers) {
			try {
				await provider.stop();
				console.log(`   ✓ ${provider.type} stopped`);
			} catch (error) {
				console.error(`   ✗ ${provider.type} stop failed:`, error);
			}
		}

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

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// TODO: SIGHUP for config reload
	process.on("SIGHUP", () => {
		console.log("⟳ Config reload requested (not implemented yet)");
	});

	// Start
	try {
		await daemon.start();
	} catch (error) {
		console.error("Failed to start:", error);
		process.exit(1);
	}
}

main();
