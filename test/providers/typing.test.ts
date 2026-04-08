import { describe, expect, test } from "bun:test";
import type { Provider } from "../../src/providers/types.js";
import { sendTypingBestEffort } from "../../src/providers/typing.js";

describe("sendTypingBestEffort", () => {
	test("does nothing when the provider has no typing support", async () => {
		const provider = {
			type: "telegram",
			start: async () => {},
			stop: async () => {},
			send: async () => ({ messageId: "1", chatId: "chat-1" }),
			onMessage: () => {},
			isConnected: () => true,
		} satisfies Provider;

		await expect(sendTypingBestEffort(provider, "chat-1")).resolves.toBeUndefined();
	});

	test("forwards typing when supported", async () => {
		const calls: string[] = [];
		const provider = {
			type: "telegram",
			start: async () => {},
			stop: async () => {},
			send: async () => ({ messageId: "1", chatId: "chat-1" }),
			sendTyping: async (chatId: string) => {
				calls.push(chatId);
			},
			onMessage: () => {},
			isConnected: () => true,
		} satisfies Provider;

		await sendTypingBestEffort(provider, "chat-1");
		expect(calls).toEqual(["chat-1"]);
	});

	test("swallows typing failures and reports them through the callback", async () => {
		const errors: string[] = [];
		const provider = {
			type: "telegram",
			start: async () => {},
			stop: async () => {},
			send: async () => ({ messageId: "1", chatId: "chat-1" }),
			sendTyping: async () => {
				throw new Error("typing failed");
			},
			onMessage: () => {},
			isConnected: () => true,
		} satisfies Provider;

		await expect(
			sendTypingBestEffort(provider, "chat-1", (message) => errors.push(message)),
		).resolves.toBeUndefined();
		expect(errors).toEqual(["[telegram] typing failed: typing failed"]);
	});
});
