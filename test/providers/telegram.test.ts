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
