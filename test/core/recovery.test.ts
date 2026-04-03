import { describe, expect, test } from "bun:test";
import {
	type RecoveryNotificationTarget,
	buildAffectedChatRecoveryMessage,
	buildStartupRecoveryMessage,
	dedupeRecoveryTargets,
} from "../../src/core/recovery.js";

describe("recovery notifications", () => {
	test("dedupes recovery targets by provider and chat", () => {
		const targets: RecoveryNotificationTarget[] = [
			{ provider: "telegram", chatId: "123", contextKey: "telegram:contact:123" },
			{ provider: "telegram", chatId: "123", contextKey: "telegram:chat:123" },
			{ provider: "telegram", chatId: "456", contextKey: "telegram:chat:456" },
		];

		expect(dedupeRecoveryTargets(targets)).toEqual([
			{ provider: "telegram", chatId: "123", contextKey: "telegram:contact:123" },
			{ provider: "telegram", chatId: "456", contextKey: "telegram:chat:456" },
		]);
	});

	test("startup recovery message includes interrupted chats and error when available", () => {
		const text = buildStartupRecoveryMessage({
			interruptedCount: 2,
			lastFatalError: "Error: boom",
			lastHeartbeatAt: "2026-03-21T12:00:00.000Z",
		});

		expect(text).toContain("recovered after an unexpected shutdown");
		expect(text).toContain("Interrupted chats: 2");
		expect(text).toContain("boom");
	});

	test("affected chat recovery message stays user-friendly", () => {
		const text = buildAffectedChatRecoveryMessage();
		expect(text).toContain("restarted unexpectedly");
		expect(text).toContain("session history is intact");
		expect(text).toContain("Please resend");
	});
});
