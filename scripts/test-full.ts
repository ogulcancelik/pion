#!/usr/bin/env bun

/**
 * Full integration test: Telegram → Router → Runner → Telegram
 * 
 * Usage: bun run scripts/test-full.ts
 */

import { TelegramProvider } from "../src/providers/telegram.js";
import { Router } from "../src/core/router.js";
import { Runner } from "../src/core/runner.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import type { Config } from "../src/config/schema.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
	console.error("Set TELEGRAM_BOT_TOKEN environment variable");
	process.exit(1);
}
const TOKEN: string = token;

// Simple config for testing
const config: Config = {
	dataDir: "~/.pion",
	telegram: { botToken: TOKEN },
	agents: {
		main: {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "~/.pion/agents/main",
			systemPrompt: `You are responding via Telegram.
Keep responses concise - this is chat, not email.`,
			skills: [],
		},
	},
	routes: [
		// All DMs go to main agent
		{ match: { type: "dm" }, agent: "main", isolation: "per-contact" },
		// Ignore groups for now
		{ match: { type: "group" }, agent: null, isolation: "per-chat" },
	],
};

async function main() {
	console.log("🚀 Starting Pion full test...\n");

	// Ensure agent workspace exists with default files
	ensureWorkspace("~/.pion/agents/main");
	console.log("✓ Workspace ready");

	// Initialize components
	const provider = new TelegramProvider({ botToken: TOKEN });
	const router = new Router(config);
	const runner = new Runner({ dataDir: config.dataDir });

	// Wire up message handling
	provider.onMessage(async (message) => {
		console.log(`\n📨 ${message.senderName}: ${message.text}`);

		// Route the message
		const route = router.route(message);
		console.log(`   → Route: ${route.agentName ?? "ignored"} (${route.isolation})`);

		if (!route.agent) {
			console.log("   → Ignoring (no agent)");
			return;
		}

		try {
			// Process with agent
			console.log("   → Processing with pi-agent...");

			const result = await runner.process(message, {
				agentConfig: route.agent,
				contextKey: route.contextKey,
			}, {
				onTextBlock: (chunk: string) => {
					// For now, just log chunks - later we'll stream them
					console.log(`   📤 Chunk: ${chunk.slice(0, 50)}...`);
				},
			});

			// Send warnings
			for (const warning of result.warnings) {
				await provider.send({
					chatId: message.chatId,
					text: warning,
				});
			}

			// Send response
			if (result.response) {
				await provider.send({
					chatId: message.chatId,
					text: result.response,
					replyTo: message.id,
				});
				console.log(`   ✓ Sent response (${result.response.length} chars)`);
			}
		} catch (error) {
			console.error("   ✗ Error:", error);
			await provider.send({
				chatId: message.chatId,
				text: `Sorry, I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`,
				replyTo: message.id,
			});
		}
	});

	// Start provider
	await provider.start();
	console.log("✓ Ready! Send a message to your bot\n");

	// Keep alive
	process.on("SIGINT", async () => {
		console.log("\n👋 Stopping...");
		await provider.stop();
		process.exit(0);
	});
}

main().catch((error) => {
	console.error("Fatal:", error);
	process.exit(1);
});
