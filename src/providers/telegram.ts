import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Bot, InputFile } from "grammy";
import { markdownToTelegramHtml } from "./telegram-format.js";
import type {
	ActionMessage,
	MediaAttachment,
	Message,
	OutboundMessage,
	Provider,
	SendResult,
	StatusHandle,
	StatusUpdate,
} from "./types.js";

export interface TelegramProviderConfig {
	botToken: string;
}

/**
 * Telegram provider using Grammy.
 */
function buildInlineKeyboard(actions?: StatusUpdate["actions"]) {
	if (!actions || actions.length === 0) {
		return undefined;
	}

	return {
		inline_keyboard: actions.map((action) => [
			{
				text: action.label,
				callback_data: action.id,
			},
		]),
	};
}

export class TelegramProvider implements Provider {
	readonly type = "telegram" as const;

	private bot: Bot;
	private messageHandler?: (message: Message) => void | Promise<void>;
	private actionHandler?: (action: ActionMessage) => void | Promise<void>;
	private connected = false;
	private stickerSetTitleCache = new Map<string, string>();

	constructor(private config: TelegramProviderConfig) {
		this.bot = new Bot(config.botToken);
		this.setupHandlers();
	}

	private dispatchMessage(message: Message): void {
		if (!this.messageHandler) return;
		Promise.resolve(this.messageHandler(message)).catch((err: unknown) => {
			console.error("[telegram] handler error:", err);
		});
	}

	private dispatchAction(callbackQuery: {
		id: string;
		from: { id: number | string; first_name?: string; username?: string };
		data: string;
		message?: {
			message_id: number | string;
			date: number;
			chat: { id: number | string; type: string };
		};
	}): void {
		if (!this.actionHandler || !callbackQuery.message) return;
		const message = callbackQuery.message;
		const action: ActionMessage = {
			id: callbackQuery.id,
			chatId: String(message.chat.id),
			senderId: String(callbackQuery.from.id),
			senderName: callbackQuery.from.first_name ?? callbackQuery.from.username,
			provider: "telegram",
			timestamp: new Date(message.date * 1000),
			isGroup: message.chat.type === "group" || message.chat.type === "supergroup",
			actionId: callbackQuery.data,
			messageId: String(message.message_id),
			data: callbackQuery.data,
			raw: callbackQuery,
		};
		Promise.resolve(this.actionHandler(action)).catch((err: unknown) => {
			console.error("[telegram] action handler error:", err);
		});
	}

	private async getStickerPackLabel(setName?: string): Promise<string | undefined> {
		if (!setName) return undefined;

		const cached = this.stickerSetTitleCache.get(setName);
		if (cached) return cached;

		try {
			const stickerSet = await this.bot.api.getStickerSet(setName);
			const label = stickerSet.title?.trim() ? `${stickerSet.title} (${setName})` : setName;
			this.stickerSetTitleCache.set(setName, label);
			return label;
		} catch (error) {
			console.warn("[telegram] Failed to resolve sticker pack title:", error);
			this.stickerSetTitleCache.set(setName, setName);
			return setName;
		}
	}

	private setupHandlers(): void {
		this.bot.on("callback_query:data", async (ctx) => {
			this.dispatchAction(ctx.callbackQuery);
		});

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

			this.dispatchMessage(message);
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
				text: msg.caption ?? "",
				media: [media],
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			this.dispatchMessage(message);
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

			this.dispatchMessage(message);
		});

		// Handle stickers
		this.bot.on("message:sticker", async (ctx) => {
			if (!this.messageHandler) return;

			const msg = ctx.message;
			const chat = ctx.chat;
			const sticker = msg.sticker;
			const packLabel = await this.getStickerPackLabel(sticker.set_name);
			const emojiHint = sticker.emoji?.trim();
			const stickerText =
				emojiHint && packLabel
					? `Sticker sent. Emoji equivalent: ${emojiHint}. Pack: ${packLabel}.`
					: emojiHint
						? `Sticker sent. Emoji equivalent: ${emojiHint}.`
						: packLabel
							? `Sticker sent. Pack: ${packLabel}.`
							: "Sticker sent.";

			console.log("[telegram] Sticker received:", {
				file_id: sticker.file_id,
				emoji: sticker.emoji,
				set_name: sticker.set_name,
				pack: packLabel,
			});

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: stickerText,
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			this.dispatchMessage(message);
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

			const file = await ctx.api.getFile(voice.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

			const media: MediaAttachment = {
				type: "audio",
				url: fileUrl,
				mimeType: voice.mime_type,
				fileName: file.file_path?.split("/").pop() || `voice-${msg.message_id}.ogg`,
			};

			const message: Message = {
				id: String(msg.message_id),
				chatId: String(chat.id),
				senderId: String(msg.from?.id ?? "unknown"),
				senderName: msg.from?.first_name ?? msg.from?.username,
				text: "",
				media: [media],
				isGroup: chat.type === "group" || chat.type === "supergroup",
				provider: "telegram",
				timestamp: new Date(msg.date * 1000),
				raw: msg,
			};

			this.dispatchMessage(message);
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
		await this.bot.api.setMyCommands([
			{ command: "stop", description: "stop the current run" },
			{ command: "new", description: "clear the session and start fresh" },
			{ command: "compact", description: "summarize and continue in a fresh session" },
			{
				command: "checkupdate",
				description: "check whether this Pion checkout is behind upstream",
			},
			{ command: "settings", description: "show runner controls and context info" },
			{ command: "restart", description: "restart the daemon and reload config" },
		]);
		await this.bot.api.setChatMenuButton({
			menu_button: { type: "commands" },
		});

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

		return this.sendTextMessage(chatId, message.text, message.replyTo);
	}

	async upsertStatus(status: StatusUpdate): Promise<StatusHandle> {
		const htmlText = markdownToTelegramHtml(status.text);
		const replyMarkup = buildInlineKeyboard(status.actions);

		if (status.handle) {
			try {
				await this.bot.api.editMessageText(
					status.chatId,
					Number(status.handle.messageId),
					htmlText,
					{
						parse_mode: "HTML",
						reply_markup: replyMarkup,
					},
				);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				if (!errMsg.toLowerCase().includes("message is not modified")) {
					throw error;
				}
			}
			return status.handle;
		}

		const sent = await this.sendTextMessage(status.chatId, status.text, undefined, replyMarkup);
		return {
			provider: "telegram",
			chatId: sent.chatId,
			messageId: sent.messageId,
		};
	}

	async clearStatus(handle: StatusHandle): Promise<void> {
		await this.bot.api.deleteMessage(handle.chatId, Number(handle.messageId));
	}

	async sendControlMenu(options: {
		chatId: string;
		text: string;
		buttons: string[][];
		replyTo?: string;
	}): Promise<SendResult> {
		return this.sendTextMessage(options.chatId, options.text, options.replyTo, {
			keyboard: options.buttons.map((row) => row.map((text) => ({ text }))),
			resize_keyboard: true,
			one_time_keyboard: true,
			is_persistent: false,
		});
	}

	private async sendTextMessage(
		chatId: string,
		text: string,
		replyTo?: string,
		replyMarkup?:
			| { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
			| {
					keyboard: Array<Array<{ text: string }>>;
					resize_keyboard?: boolean;
					one_time_keyboard?: boolean;
					is_persistent?: boolean;
			  },
	): Promise<SendResult> {
		const htmlText = markdownToTelegramHtml(text);

		try {
			const result = await this.bot.api.sendMessage(chatId, htmlText, {
				parse_mode: "HTML",
				reply_markup: replyMarkup,
				reply_to_message_id: replyTo ? Number(replyTo) : undefined,
			});

			return {
				messageId: String(result.message_id),
				chatId: String(result.chat.id),
			};
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : "";
			if (errMsg.includes("parse") || errMsg.includes("entities")) {
				console.warn("[telegram] HTML parse failed, falling back to plain text");
				const result = await this.bot.api.sendMessage(chatId, text, {
					reply_markup: replyMarkup,
					reply_to_message_id: replyTo ? Number(replyTo) : undefined,
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
			try {
				unlinkSync(tmpFile);
			} catch {}
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

	onAction(handler: (action: ActionMessage) => void | Promise<void>): void {
		this.actionHandler = handler;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/** Get bot info */
	async getMe() {
		return this.bot.api.getMe();
	}
}
