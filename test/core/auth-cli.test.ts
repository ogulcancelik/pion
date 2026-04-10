import { describe, expect, test } from "bun:test";
import {
	buildProviderSelectionPrompt,
	chooseLoginProvider,
	resolveProviderSelection,
} from "../../src/core/auth-cli.js";
import type { SupportedAuthProvider } from "../../src/core/auth.js";

const providers: SupportedAuthProvider[] = [
	{ id: "anthropic", label: "Anthropic (Claude Pro/Max)", method: "oauth" },
	{ id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus/Pro)", method: "oauth" },
	{ id: "minimax", label: "MiniMax", method: "api_key", envVar: "MINIMAX_API_KEY" },
];

describe("auth CLI provider selection", () => {
	test("formats a provider chooser prompt with numbered entries", () => {
		const prompt = buildProviderSelectionPrompt(providers);
		expect(prompt).toContain("Choose auth provider:");
		expect(prompt).toContain("1. anthropic");
		expect(prompt).toContain("2. openai-codex");
		expect(prompt).toContain("3. minimax");
		expect(prompt).toContain("Enter number or provider id");
	});

	test("resolves numeric provider selections", () => {
		expect(resolveProviderSelection(providers, "1")?.id).toBe("anthropic");
		expect(resolveProviderSelection(providers, "2")?.id).toBe("openai-codex");
		expect(resolveProviderSelection(providers, "3")?.id).toBe("minimax");
	});

	test("resolves provider ids case-insensitively", () => {
		expect(resolveProviderSelection(providers, "anthropic")?.id).toBe("anthropic");
		expect(resolveProviderSelection(providers, "OPENAI-CODEX")?.id).toBe("openai-codex");
	});

	test("accepts openai as an alias for openai-codex", () => {
		expect(resolveProviderSelection(providers, "openai")?.id).toBe("openai-codex");
	});

	test("returns undefined for invalid selections", () => {
		expect(resolveProviderSelection(providers, "")).toBeUndefined();
		expect(resolveProviderSelection(providers, "0")).toBeUndefined();
		expect(resolveProviderSelection(providers, "4")).toBeUndefined();
		expect(resolveProviderSelection(providers, "something-else")).toBeUndefined();
	});

	test("uses the requested provider directly when one was provided", async () => {
		let promptCalls = 0;
		const result = await chooseLoginProvider({
			requestedProvider: "openai-codex",
			providers,
			prompt: async () => {
				promptCalls += 1;
				return "1";
			},
		});

		expect(result).toBe("openai-codex");
		expect(promptCalls).toBe(0);
	});

	test("re-prompts until a valid provider is chosen", async () => {
		const answers = ["", "openai", "2"];
		const prompts: string[] = [];
		const result = await chooseLoginProvider({
			providers,
			prompt: async (question) => {
				prompts.push(question);
				return answers.shift() ?? "2";
			},
		});

		expect(result).toBe("openai-codex");
		expect(prompts).toHaveLength(2);
	});
});
