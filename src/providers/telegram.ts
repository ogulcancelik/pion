import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, InputFile } from "grammy";
import { markdownToTelegramHtml } from "./telegram-format.js";
import type { MediaAttachment, Message, OutboundMessage, Provider, SendResult } from "./types.js";

export interface TelegramProviderConfig {
	botToken: string;
}

/**
 * Telegram provider using Grammy.
 */
export class TelegramProvider implements Provider {
	readonly type = "telegram" as const;

	private bot: Bot;
	private messageHandler?: (message: Message) => void | Promise<void>;
	private connected = false;

	constructor(private config: TelegramProviderConfig) {
		this.bot = new Bot(config.botToken);
		this.setupHandlers();
	}

	private setupHandlers(): void {
		// Handle text messages
		this.bot.on("message:text", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: msg.text,
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
		});

		// Handle photos
		this.bot.on("message:photo", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;

			// Get the largest photo
			const photo = msg.photo[msg.photo.length - 1];
			if (!photo) return;
			const file = await ctx.api.getFile(photo.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

			const media: MediaAttachment = {
				type: "image",
				url: fileUrl,
				mimeType: "image/jpeg",
			};

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: msg.caption || "[image]",
				media: [media],
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
		});

		// Handle documents
		this.bot.on("message:document", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;
			const doc = msg.document;

			const file = await ctx.api.getFile(doc.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

			const media: MediaAttachment = {
				type: "document",
				url: fileUrl,
				mimeType: doc.mime_type,
				fileName: doc.file_name,
			};

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: msg.caption ?? "",
				media: [media],
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
		});

		// Handle stickers
		this.bot.on("message:sticker", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;
			const sticker = msg.sticker;

			// Log sticker info for debugging/learning file_ids
			console.log("[telegram] Sticker received:", {
				file_id: sticker.file_id,
				emoji: sticker.emoji,
				set_name: sticker.set_name,
			});

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: `[Sticker: ${sticker.emoji || "?"}] file_id: ${sticker.file_id}`,
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
		});

		// Handle voice messages
		this.bot.on("message:voice", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;
			const voice = msg.voice;

			console.log("[telegram] Voice message received:", {
				duration: voice.duration,
				file_size: voice.file_size,
				mime_type: voice.mime_type,
			});

			try {
				// Download the voice file
				const file = await ctx.api.getFile(voice.file_id);
				const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
				
				const response = await fetch(fileUrl);
				if (!response.ok) {
					console.error("[telegram] Failed to download voice file");
					return;
				}
				const buffer = Buffer.from(await response.arrayBuffer());

				// Save to tmp as ogg
				const tmpDir = join(tmpdir(), "pion-voice");
				mkdirSync(tmpDir, { recursive: true });
				const oggPath = join(tmpDir, `voice-${Date.now()}.ogg`);
				const wavPath = oggPath.replace(".ogg", ".wav");
				writeFileSync(oggPath, buffer);

				// Convert ogg to wav (16kHz mono) using ffmpeg
				const { execSync } = await import("node:child_process");
				execSync(`ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`);

				// Transcribe using voxtype (with pion config for auto language detection)
				const home = process.env.HOME || "~";
				const voxConfig = `${home}/.pion/voxtype/config.toml`;
				const configFlag = existsSync(voxConfig) ? `-c "${voxConfig}"` : "";
				const transcription = execSync(
					`${home}/.local/bin/voxtype ${configFlag} transcribe "${wavPath}"`,
					{ encoding: "utf-8", timeout: 30000 },
				).trim();

				// Cleanup temp files
				try { unlinkSync(oggPath); } catch {}
				try { unlinkSync(wavPath); } catch {}

				console.log(`[telegram] Transcribed voice: "${transcription.slice(0, 50)}..."`);

				const message: Message = {
					id: String(msg.message_id),
					chatId: String(chat.id),
					senderId: String(msg.from?.id ?? "unknown"),
					senderName: msg.from?.first_name ?? msg.from?.username,
					text: transcription || "[empty voice message]",
					isGroup: chat.type === "group" || chat.type === "supergroup",
					provider: "telegram",
					timestamp: new Date(msg.date * 1000),
					raw: msg,
				};

				void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
			} catch (err) {
				console.error("[telegram] Voice transcription failed:", err instanceof Error ? err.message : err);
				
				// Still send message so user knows it was received
				const message: Message = {
					id: String(msg.message_id),
					chatId: String(chat.id),
					senderId: String(msg.from?.id ?? "unknown"),
					senderName: msg.from?.first_name ?? msg.from?.username,
					text: "[voice message - transcription failed]",
					isGroup: chat.type === "group" || chat.type === "supergroup",
					provider: "telegram",
					timestamp: new Date(msg.date * 1000),
					raw: msg,
				};

				void this.messageHandler(message).catch((err) => console.error("[telegram] handler error:", err));
			}
		});

		// Error handling
		this.bot.catch((err) => {
			console.error("[telegram] Bot error:", err.message);
		});
	}

	async start(): Promise<void> {
		// Verify token works
		const me = await this.bot.api.getMe();
		console.log(`[telegram] Connected as @${me.username}`);

		// Start polling
		this.bot.start({
			onStart: () => {
				this.connected = true;
				console.log("[telegram] Polling started");
			},
		});
	}

	async stop(): Promise<void> {
		await this.bot.stop();
		this.connected = false;
		console.log("[telegram] Stopped");
	}

	async send(message: OutboundMessage): Promise<SendResult> {
		const chatId = message.chatId;

		// Telegram has a 4096 char limit — send long messages as a document
		if (message.text.length > 4000) {
			return this.sendAsDocument(chatId, message.text, message.replyTo);
		}

		const htmlText = markdownToTelegramHtml(message.text);

		// TODO: Handle media attachments
		try {
			const result = await this.bot.api.sendMessage(chatId, htmlText, {
				parse_mode: "HTML",
				reply_to_message_id: message.replyTo ? Number(message.replyTo) : undefined,
			});

			return {
				messageId: String(result.message_id),
				chatId: String(result.chat.id),
			};
		} catch (error) {
			// If HTML parsing fails, fall back to plain text
			const errMsg = error instanceof Error ? error.message : "";
			if (errMsg.includes("parse") || errMsg.includes("entities")) {
				console.warn("[telegram] HTML parse failed, falling back to plain text");
				const result = await this.bot.api.sendMessage(chatId, message.text, {
					reply_to_message_id: message.replyTo ? Number(message.replyTo) : undefined,
				});
				return {
					messageId: String(result.message_id),
					chatId: String(result.chat.id),
				};
			}
			throw error;
		}
	}

	/**
	 * Send a long text response as a .md document attachment.
	 */
	private async sendAsDocument(
		chatId: string,
		text: string,
		replyTo?: string,
	): Promise<SendResult> {
		const tmpDir = join(tmpdir(), "pion");
		mkdirSync(tmpDir, { recursive: true });
		const tmpFile = join(tmpDir, `response-${Date.now()}.md`);
		writeFileSync(tmpFile, text, "utf-8");

		try {
			const inputFile = new InputFile(tmpFile, "response.md");
			const result = await this.bot.api.sendDocument(chatId, inputFile, {
				caption: "Response too long for a message — full text attached.",
				reply_to_message_id: replyTo ? Number(replyTo) : undefined,
			});

			return {
				messageId: String(result.message_id),
				chatId: String(result.chat.id),
			};
		} finally {
			try { unlinkSync(tmpFile); } catch {}
		}
	}

	/**
	 * Send typing indicator. Lasts ~5 seconds or until a message is sent.
	 */
	async sendTyping(chatId: string): Promise<void> {
		await this.bot.api.sendChatAction(chatId, "typing");
	}

	/**
	 * Send a sticker by file_id.
	 */
	async sendSticker(chatId: string, fileId: string): Promise<SendResult> {
		const result = await this.bot.api.sendSticker(chatId, fileId);
		return {
			messageId: String(result.message_id),
			chatId: String(result.chat.id),
		};
	}

	/**
	 * Send a file from the filesystem.
	 * Supports any file type - Telegram will handle it appropriately.
	 */
	async sendFile(
		chatId: string,
		filePath: string,
		options?: { caption?: string; replyTo?: string },
	): Promise<SendResult> {
		// Validate file exists
		if (!existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		const fileName = basename(filePath);
		const inputFile = new InputFile(filePath, fileName);

		const result = await this.bot.api.sendDocument(chatId, inputFile, {
			caption: options?.caption,
			reply_to_message_id: options?.replyTo ? Number(options.replyTo) : undefined,
		});

		return {
			messageId: String(result.message_id),
			chatId: String(result.chat.id),
		};
	}

	onMessage(handler: (message: Message) => void | Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/** Get bot info */
	async getMe() {
		return this.bot.api.getMe();
	}
}
