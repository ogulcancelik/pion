/**
 * WhatsApp provider using Baileys.
 *
 * Authentication via QR code printed to terminal.
 * Session state persisted to authDir.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	type WASocket,
	type proto,
	type ConnectionState,
} from "@whiskeysockets/baileys";
import type { Message, OutboundMessage, Provider, SendResult } from "./types.js";

export interface WhatsAppProviderConfig {
	/** Directory to store auth session state */
	authDir: string;
	/** Print QR code to terminal (default: true) */
	printQRInTerminal?: boolean;
	/** Allowed phone numbers for DMs (e.g., ["+1234567890"]) */
	allowDMs?: string[];
	/** Allowed group JIDs (e.g., ["120363403098358590@g.us"]) */
	allowGroups?: string[];
}

type BaileysMessage = proto.IWebMessageInfo;

/**
 * WhatsApp provider using Baileys library.
 */
export class WhatsAppProvider implements Provider {
	readonly type = "whatsapp" as const;

	private config: WhatsAppProviderConfig;
	private socket: WASocket | null = null;
	private messageHandler?: (message: Message) => void | Promise<void>;
	private connected = false;
	private reconnecting = false;

	constructor(config: WhatsAppProviderConfig) {
		this.config = {
			printQRInTerminal: true,
			...config,
		};
	}

	/**
	 * Ensure auth directory exists.
	 */
	ensureAuthDir(): void {
		if (!existsSync(this.config.authDir)) {
			mkdirSync(this.config.authDir, { recursive: true });
		}
	}

	async start(): Promise<void> {
		this.ensureAuthDir();

		const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

		// Create silent logger to suppress baileys noise
		const silentLogger = {
			level: "silent" as const,
			child: () => silentLogger,
			trace: () => {},
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: console.error,
		};

		this.socket = makeWASocket({
			auth: state,
			printQRInTerminal: this.config.printQRInTerminal,
			// Don't mark as online to receive notifications on phone
			markOnlineOnConnect: false,
			// biome-ignore lint/suspicious/noExplicitAny: baileys logger type is complex
			logger: silentLogger as any,
		});

		// Handle connection updates
		this.socket.ev.on("connection.update", (update: Partial<ConnectionState>) => {
			this.handleConnectionUpdate(update);
		});

		// Handle credential updates (save session)
		this.socket.ev.on("creds.update", saveCreds);

		// Handle incoming messages
		this.socket.ev.on("messages.upsert", (event) => {
			this.handleMessagesUpsert(event);
		});

		// Wait for initial connection
		await this.waitForConnection();
	}

	private async waitForConnection(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("WhatsApp connection timeout"));
			}, 60000); // 60 second timeout for QR scanning

			const checkConnection = () => {
				if (this.connected) {
					clearTimeout(timeout);
					resolve();
				} else {
					setTimeout(checkConnection, 100);
				}
			};
			checkConnection();
		});
	}

	private handleConnectionUpdate(update: Partial<ConnectionState>): void {
		const { connection, lastDisconnect } = update;

		if (connection === "close") {
			this.connected = false;
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
			const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

			console.log(
				`[whatsapp] Connection closed: ${lastDisconnect?.error?.message || "unknown"}`,
				shouldReconnect ? "(reconnecting)" : "(logged out)",
			);

			if (shouldReconnect && !this.reconnecting) {
				this.reconnecting = true;
				setTimeout(() => {
					this.reconnecting = false;
					this.start().catch((err) => {
						console.error("[whatsapp] Reconnection failed:", err);
					});
				}, 3000);
			}
		} else if (connection === "open") {
			this.connected = true;
			console.log("[whatsapp] Connected");
		}
	}

	private handleMessagesUpsert(event: { messages: BaileysMessage[]; type: string }): void {
		if (!this.messageHandler) return;

		for (const msg of event.messages) {
			const normalized = this.normalizeMessage(msg);
			if (normalized) {
				this.messageHandler(normalized).catch((err) => {
					console.error("[whatsapp] Error handling message:", err);
				});
			}
		}
	}

	/**
	 * Normalize a Baileys message to our common Message format.
	 * Returns null if the message should be skipped.
	 */
	normalizeMessage(msg: BaileysMessage): Message | null {
		const key = msg.key;
		if (!key) return null;

		// Skip messages from self
		if (key.fromMe) return null;

		// Skip status broadcasts
		if (key.remoteJid === "status@broadcast") return null;

		// Determine if group message (JID ends with @g.us)
		const isGroup = key.remoteJid?.endsWith("@g.us") ?? false;

		// Check allowlist
		if (!this.isAllowed(key.remoteJid ?? "", isGroup)) {
			// Log blocked messages to help discover group JIDs
			const type = isGroup ? "group" : "DM";
			console.log(`[whatsapp] Blocked ${type}: ${key.remoteJid}`);
			return null;
		}

		// Extract text content
		const text = this.extractText(msg);
		if (!text) return null;

		// In groups, participant is the actual sender
		const senderId = isGroup ? key.participant : key.remoteJid;

		// Timestamp - baileys gives it as number (unix epoch)
		const timestamp =
			typeof msg.messageTimestamp === "number" ? new Date(msg.messageTimestamp * 1000) : new Date();

		return {
			id: key.id ?? "",
			chatId: key.remoteJid ?? "",
			senderId: senderId ?? "",
			senderName: msg.pushName,
			text,
			isGroup,
			provider: "whatsapp",
			timestamp,
			raw: msg,
		};
	}

	/**
	 * Check if a chat is allowed based on allowlists.
	 */
	private isAllowed(jid: string, isGroup: boolean): boolean {
		if (isGroup) {
			const allowGroups = this.config.allowGroups ?? [];
			// Empty allowlist = block all
			if (allowGroups.length === 0) return false;
			return allowGroups.includes(jid);
		}
		const allowDMs = this.config.allowDMs ?? [];
		// Empty allowlist = block all
		if (allowDMs.length === 0) return false;
		// Extract phone number from JID (e.g., "1234567890@s.whatsapp.net" → "1234567890")
		const phone = jid.replace("@s.whatsapp.net", "");
		// Check if any allowDM entry matches (strip + for comparison)
		return allowDMs.some((allowed) => {
			const normalizedAllowed = allowed.replace(/^\+/, "");
			return phone === normalizedAllowed;
		});
	}

	/**
	 * Extract text content from various message types.
	 */
	private extractText(msg: BaileysMessage): string | null {
		const content = msg.message;
		if (!content) return null;

		// Regular text message
		if (content.conversation) {
			return content.conversation;
		}

		// Extended text (with link preview, etc.)
		if (content.extendedTextMessage?.text) {
			return content.extendedTextMessage.text;
		}

		// Image with caption
		if (content.imageMessage?.caption) {
			return content.imageMessage.caption;
		}

		// Video with caption
		if (content.videoMessage?.caption) {
			return content.videoMessage.caption;
		}

		// Document with caption
		if (content.documentMessage?.caption) {
			return content.documentMessage.caption;
		}

		return null;
	}

	async stop(): Promise<void> {
		if (this.socket) {
			this.socket.end(undefined);
			this.socket = null;
		}
		this.connected = false;
		console.log("[whatsapp] Stopped");
	}

	async send(message: OutboundMessage): Promise<SendResult> {
		if (!this.socket) {
			throw new Error("WhatsApp not connected");
		}

		const result = await this.socket.sendMessage(message.chatId, {
			text: message.text,
		});

		return {
			messageId: result?.key?.id ?? "",
			chatId: message.chatId,
		};
	}

	async sendTyping(chatId: string): Promise<void> {
		if (!this.socket) return;

		await this.socket.sendPresenceUpdate("composing", chatId);
	}

	onMessage(handler: (message: Message) => void | Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connected;
	}
}
