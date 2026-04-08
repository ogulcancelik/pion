import { describe, expect, test } from "bun:test";
import {
	type SettingsViewModel,
	buildSettingsText,
	formatContextUsage,
	formatTokenCount,
} from "../../src/core/settings.js";

describe("settings formatting", () => {
	test("formats token counts like pi footer", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1_234)).toBe("1.2k");
		expect(formatTokenCount(52_100)).toBe("52k");
		expect(formatTokenCount(1_300_000)).toBe("1.3M");
	});

	test("formats full context usage with used, total, and percent", () => {
		expect(
			formatContextUsage({
				tokens: 52_100,
				contextWindow: 127_000,
				percent: 41.02,
			}),
		).toBe("52k / 127k (41%)");
	});

	test("builds human-facing settings text without raw context key", () => {
		const text = buildSettingsText({
			status: "💬 session active",
			agentName: "main",
			model: "minimax/MiniMax-M2.7",
			isolation: "per-contact",
			contextKey: "telegram:contact:1181797377",
			contextUsage: {
				tokens: 52_100,
				contextWindow: 127_000,
				percent: 41.02,
			},
		} satisfies SettingsViewModel);

		expect(text).toContain("**Runner controls**");
		expect(text).toContain("status: 💬 session active");
		expect(text).toContain("agent: `main`");
		expect(text).toContain("model: `minimax/MiniMax-M2.7`");
		expect(text).toContain("session: `dm`");
		expect(text).toContain("scope: `per-contact`");
		expect(text).toContain("usage: `52k / 127k (41%)`");
		expect(text).not.toContain("telegram:contact:1181797377");
	});
});
