#!/usr/bin/env bun

/**
 * WhatsApp Pairing Script
 * 
 * Standalone script to pair WhatsApp via QR code.
 * Run this once to authenticate, then daemon can use saved credentials.
 * 
 * Usage:
 *   bun run whatsapp:pair
 */

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import { existsSync, mkdirSync } from "node:fs";
import qrcode from "qrcode-terminal";
import { loadConfig } from "../src/config/loader.js";

async function main() {
	console.log("📱 WhatsApp Pairing\n");

	// Load config to get auth directory
	let authDir: string;
	try {
		const config = loadConfig();
		const home = process.env.HOME || "~";
		authDir = config.whatsapp?.sessionDir?.replace(/^~/, home) ?? `${home}/.pion/whatsapp-auth`;
	} catch {
		const home = process.env.HOME || "~";
		authDir = `${home}/.pion/whatsapp-auth`;
		console.log("⚠ No config found, using default auth directory");
	}

	console.log(`Auth directory: ${authDir}\n`);

	// Ensure directory exists
	if (!existsSync(authDir)) {
		mkdirSync(authDir, { recursive: true });
	}

	// Check if already authenticated
	const credsFile = `${authDir}/creds.json`;
	if (existsSync(credsFile)) {
		console.log("✓ Existing credentials found");
		console.log("  Connecting to verify...\n");
	} else {
		console.log("No existing credentials found");
		console.log("  Scan the QR code with WhatsApp on your phone\n");
	}

	const { state, saveCreds } = await useMultiFileAuthState(authDir);

	const socket = makeWASocket({
		auth: state,
		markOnlineOnConnect: false,
	});

	// Handle connection updates
	socket.ev.on("connection.update", async (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			console.log("\n📲 Scan this QR code with WhatsApp:\n");
			qrcode.generate(qr, { small: true });
			console.log("");
		}

		if (connection === "close") {
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
			const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

			if (statusCode === DisconnectReason.loggedOut) {
				console.log("\n❌ Logged out. Delete auth directory and try again:");
				console.log(`   rm -rf ${authDir}`);
				process.exit(1);
			} else if (shouldReconnect) {
				console.log("\n⚠ Connection closed, reconnecting...");
				// Don't reconnect in pairing script - just exit
				process.exit(1);
			}
		} else if (connection === "open") {
			console.log("\n✅ WhatsApp connected successfully!");
			console.log("   Credentials saved to:", authDir);
			console.log("\n   You can now start the daemon:");
			console.log("   bun run daemon\n");
			
			// Give it a moment to save creds
			setTimeout(() => {
				socket.end(undefined);
				process.exit(0);
			}, 1000);
		}
	});

	// Save credentials when updated
	socket.ev.on("creds.update", saveCreds);

	// Handle Ctrl+C
	process.on("SIGINT", () => {
		console.log("\n\nPairing cancelled.");
		socket.end(undefined);
		process.exit(0);
	});

	console.log("Waiting for connection... (Ctrl+C to cancel)\n");
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
