import { describe, expect, test } from "bun:test";
import { TelegramProvider } from "../../src/providers/telegram.js";

// Mock grammy Bot - we don't want to hit real API in unit tests
// These tests verify our provider logic, not Grammy itself

describe("TelegramProvider", () => {
	function createProvider() {
		const provider = new TelegramProvider({ botToken: "test-token" });
		const api = {
			sendMessage: async () => ({
				message_id: 42,
				chat: { id: 123 },
			}),
			editMessageText: async () => true,
			deleteMessage: async () => true,
			setChatMenuButton: async () => true,
		};
		(provider as any).bot = { api };
		return { provider, api };
	}

	test("implements Provider interface", () => {
		expect(TelegramProvider).toBeDefined();
		expect(TelegramProvider.prototype.start).toBeDefined();
		expect(TelegramProvider.prototype.stop).toBeDefined();
		expect(TelegramProvider.prototype.send).toBeDefined();
		expect(TelegramProvider.prototype.upsertStatus).toBeDefined();
		expect(TelegramProvider.prototype.clearStatus).toBeDefined();
		expect(TelegramProvider.prototype.onMessage).toBeDefined();
		expect(TelegramProvider.prototype.isConnected).toBeDefined();
	});

	test("has correct type property", () => {
		expect(typeof TelegramProvider.prototype.isConnected).toBe("function");
	});

	test("upsertStatus sends a new message when no handle exists", async () => {
		const { provider, api } = createProvider();
		let sendArgs: any[] | undefined;
		api.sendMessage = async (...args: any[]) => {
			sendArgs = args;
			return {
				message_id: 42,
				chat: { id: 123 },
			};
		};

		const handle = await provider.upsertStatus?.({
			chatId: "123",
			text: "⚙️ working",
		});

		expect(sendArgs).toBeDefined();
		expect(sendArgs?.[0]).toBe("123");
		expect(sendArgs?.[1]).toContain("⚙️ working");
		expect(handle).toEqual({
			provider: "telegram",
			chatId: "123",
			messageId: "42",
		});
	});

	test("upsertStatus edits an existing status message when handle exists", async () => {
		const { provider, api } = createProvider();
		let editArgs: any[] | undefined;
		api.editMessageText = async (...args: any[]) => {
			editArgs = args;
			return true;
		};

		const handle = await provider.upsertStatus?.({
			chatId: "123",
			handle: {
				provider: "telegram",
				chatId: "123",
				messageId: "42",
			},
			text: "updated status",
		});

		expect(editArgs).toEqual(["123", 42, expect.stringContaining("updated status"), expect.any(Object)]);
		expect(handle).toEqual({
			provider: "telegram",
			chatId: "123",
			messageId: "42",
		});
	});

	test("clearStatus deletes an existing status message", async () => {
		const { provider, api } = createProvider();
		let deleteArgs: any[] | undefined;
		api.deleteMessage = async (...args: any[]) => {
			deleteArgs = args;
			return true;
		};

		await provider.clearStatus?.({
			provider: "telegram",
			chatId: "123",
			messageId: "42",
		});

		expect(deleteArgs).toEqual(["123", 42]);
	});

	test("upsertStatus includes inline keyboard actions when sending a new status", async () => {
		const { provider, api } = createProvider();
		let sendArgs: any[] | undefined;
		api.sendMessage = async (...args: any[]) => {
			sendArgs = args;
			return {
				message_id: 42,
				chat: { id: 123 },
			};
		};

		await provider.upsertStatus?.({
			chatId: "123",
			text: "⚙️ working",
			actions: [
				{ id: "stop", label: "⏹ stop" },
				{ id: "compact", label: "🧠 compact" },
			],
		});

		expect(sendArgs?.[2]).toEqual({
			parse_mode: "HTML",
			reply_markup: {
				inline_keyboard: [
					[{ text: "⏹ stop", callback_data: "stop" }],
					[{ text: "🧠 compact", callback_data: "compact" }],
				],
			},
			reply_to_message_id: undefined,
		});
	});

	test("upsertStatus includes inline keyboard actions when editing an existing status", async () => {
		const { provider, api } = createProvider();
		let editArgs: any[] | undefined;
		api.editMessageText = async (...args: any[]) => {
			editArgs = args;
			return true;
		};

		await provider.upsertStatus?.({
			chatId: "123",
			handle: {
				provider: "telegram",
				chatId: "123",
				messageId: "42",
			},
			text: "updated status",
			actions: [{ id: "new", label: "🆕 new" }],
		});

		expect(editArgs?.[3]).toEqual({
			parse_mode: "HTML",
			reply_markup: {
				inline_keyboard: [[{ text: "🆕 new", callback_data: "new" }]],
			},
		});
	});

	test("normalizes callback queries into action events", async () => {
		const provider = new TelegramProvider({ botToken: "test-token" });
		const actions: any[] = [];
		provider.onAction?.((action) => {
			actions.push(action);
		});

		(provider as any).dispatchAction({
			id: "cbq-1",
			from: { id: 7, first_name: "Can", username: "can" },
			data: "stop",
			message: {
				message_id: 42,
				date: 1712091600,
				chat: { id: 123, type: "private" },
			},
		});

		expect(actions).toEqual([
			{
				id: "cbq-1",
				chatId: "123",
				senderId: "7",
				senderName: "Can",
				provider: "telegram",
				timestamp: new Date(1712091600 * 1000),
				isGroup: false,
				actionId: "stop",
				messageId: "42",
				data: "stop",
				raw: expect.any(Object),
			},
			]);
	});

	test("upsertStatus treats telegram 'message is not modified' as a no-op success", async () => {
		const { provider, api } = createProvider();
		api.editMessageText = async () => {
			throw new Error("Bad Request: message is not modified");
		};

		await expect(
			provider.upsertStatus?.({
				chatId: "123",
				handle: {
					provider: "telegram",
					chatId: "123",
					messageId: "42",
				},
				text: "same text",
			}),
		).resolves.toEqual({
			provider: "telegram",
			chatId: "123",
			messageId: "42",
		});
	});

	test("start registers telegram bot commands and configures the command menu button", async () => {
		const provider = new TelegramProvider({ botToken: "test-token" });
		const commandCalls: any[] = [];
		const menuButtonCalls: any[] = [];
		(provider as any).bot = {
			api: {
				getMe: async () => ({ username: "piontestbot" }),
				setMyCommands: async (...args: any[]) => {
					commandCalls.push(args);
				},
				setChatMenuButton: async (...args: any[]) => {
					menuButtonCalls.push(args);
				},
			},
			start: ({ onStart }: { onStart?: () => void }) => {
				onStart?.();
			},
			stop: async () => {},
		};

		await provider.start();

		expect(commandCalls).toEqual([
			[
				[
					{ command: "stop", description: "stop the current run" },
					{ command: "new", description: "clear the session and start fresh" },
					{ command: "compact", description: "summarize and continue in a fresh session" },
					{ command: "settings", description: "show runner controls and context info" },
				],
			],
		]);
		expect(menuButtonCalls).toEqual([[{ menu_button: { type: "commands" } }]]);
	});

	test("sendControlMenu sends a native reply keyboard with runner controls", async () => {
		const { provider, api } = createProvider();
		let sendArgs: any[] | undefined;
		api.sendMessage = async (...args: any[]) => {
			sendArgs = args;
			return {
				message_id: 77,
				chat: { id: 123 },
			};
		};

		const result = await provider.sendControlMenu?.({
			chatId: "123",
			text: "runner controls",
			buttons: [["🆕 new session", "🧠 compact"], ["⏹ stop"]],
		});

		expect(sendArgs?.[0]).toBe("123");
		expect(sendArgs?.[1]).toContain("runner controls");
		expect(sendArgs?.[2]).toEqual({
			parse_mode: "HTML",
			reply_markup: {
				keyboard: [[{ text: "🆕 new session" }, { text: "🧠 compact" }], [{ text: "⏹ stop" }]],
				resize_keyboard: true,
				one_time_keyboard: true,
				is_persistent: false,
			},
			reply_to_message_id: undefined,
		});
		expect(result).toEqual({
			messageId: "77",
			chatId: "123",
		});
	});
});

// Integration test - only runs with real token
// Run manually: TELEGRAM_BOT_TOKEN=xxx bun test telegram --test-name-pattern "integration"
describe.skipIf(!process.env.TELEGRAM_BOT_TOKEN)("TelegramProvider integration", () => {
	test("connects with valid token", async () => {
		const token = process.env.TELEGRAM_BOT_TOKEN;
		if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
		const provider = new TelegramProvider({
			botToken: token,
		});

		const me = await provider.getMe();
		expect(me.id).toBeGreaterThan(0);
		expect(me.is_bot).toBe(true);
	});
});
