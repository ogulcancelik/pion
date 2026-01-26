#!/usr/bin/env bun

/**
 * Quick test script for Telegram provider.
 * Echoes back any message you send.
 * 
 * Usage: bun run scripts/test-telegram.ts
 * Then send a message to your bot on Telegram.
 * Ctrl+C to stop.
 */

import { TelegramProvider } from "../src/providers/telegram.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
	console.error("Set TELEGRAM_BOT_TOKEN environment variable");
	process.exit(1);
}

const provider = new TelegramProvider({ botToken: TOKEN });

provider.onMessage(async (msg) => {
	console.log(`\n📨 Message from ${msg.senderName || msg.senderId}:`);
	console.log(`   Chat: ${msg.chatId} (${msg.isGroup ? "group" : "DM"})`);
	console.log(`   Text: ${msg.text}`);
	if (msg.media?.length) {
		console.log(`   Media: ${msg.media.map(m => m.type).join(", ")}`);
	}

	// Echo back
	const reply = `🔮 Pion received: "${msg.text}"`;
	await provider.send({
		chatId: msg.chatId,
		text: reply,
		replyTo: msg.id,
	});
	console.log(`   ↳ Replied!`);
});

console.log("🚀 Starting Telegram test bot...");
console.log("   Send a message to your bot on Telegram");
console.log("   Press Ctrl+C to stop\n");

await provider.start();

// Keep alive
process.on("SIGINT", async () => {
	console.log("\n👋 Stopping...");
	await provider.stop();
	process.exit(0);
});
