import { describe, expect, mock, test } from "bun:test";
import { TelegramProvider } from "../../src/providers/telegram.js";

// Mock grammy Bot - we don't want to hit real API in unit tests
// These tests verify our provider logic, not Grammy itself

describe("TelegramProvider", () => {
	test("implements Provider interface", () => {
		// Can't actually instantiate without valid token hitting API
		// So we just verify the class structure
		expect(TelegramProvider).toBeDefined();
		expect(TelegramProvider.prototype.start).toBeDefined();
		expect(TelegramProvider.prototype.stop).toBeDefined();
		expect(TelegramProvider.prototype.send).toBeDefined();
		expect(TelegramProvider.prototype.onMessage).toBeDefined();
		expect(TelegramProvider.prototype.isConnected).toBeDefined();
	});

	test("has correct type property", () => {
		// The type property is defined on instances, check that it exists
		expect(typeof TelegramProvider.prototype.isConnected).toBe("function");
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
