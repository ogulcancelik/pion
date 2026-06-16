import { describe, expect, test } from "bun:test";
import { computeStats, inferModelString } from "../../src/tui/session-stats.js";

describe("computeStats", () => {
	test("uses the supplied model context window for context percent", () => {
		const stats = computeStats(
			[
				{
					type: "message",
					message: {
						role: "assistant",
						content: [],
						model: "gpt-5.5",
						usage: {
							input: 317,
							output: 320,
							cacheRead: 195_072,
						},
					},
				},
			],
			{ contextWindow: 272_000 },
		);

		expect(stats.contextTokens).toBe(195_709);
		expect(stats.contextPercent).toBeCloseTo(71.95, 2);
	});

	test("infers the latest model_change model for offline sessions", () => {
		const model = inferModelString([
			{ type: "model_change", provider: "anthropic", modelId: "claude-old" },
			{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.5" },
		]);

		expect(model).toBe("openai-codex/gpt-5.5");
	});

	test("prefers the selected agent model when available", () => {
		const model = inferModelString(
			[{ type: "model_change", provider: "anthropic", modelId: "claude-old" }],
			{ agentModel: "openai-codex/gpt-5.5" },
		);

		expect(model).toBe("openai-codex/gpt-5.5");
	});
});
