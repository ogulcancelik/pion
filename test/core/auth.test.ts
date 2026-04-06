import { describe, expect, test } from "bun:test";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import {
	getAuthPath,
	getConfiguredAuthProviderSummaries,
	getDefaultAuthPath,
	getSupportedAuthProvider,
	getSupportedAuthProviders,
	setApiKeyCredential,
} from "../../src/core/auth.js";
import { homeDir } from "../../src/core/paths.js";

describe("auth path helpers", () => {
	test("default auth path points to pion auth store", () => {
		expect(getDefaultAuthPath()).toBe(`${homeDir()}/.pion/auth.json`);
	});

	test("getAuthPath uses config override when provided", () => {
		expect(getAuthPath({ authPath: "~/.custom/auth.json" })).toBe(`${homeDir()}/.custom/auth.json`);
	});

	test("getAuthPath falls back to pion auth store", () => {
		expect(getAuthPath()).toBe(`${homeDir()}/.pion/auth.json`);
	});
});

describe("auth provider helpers", () => {
	test("lists supported auth providers across oauth and api-key flows", () => {
		const providers = getSupportedAuthProviders();
		expect(providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "anthropic", method: "oauth" }),
				expect.objectContaining({ id: "openai-codex", method: "oauth" }),
				expect.objectContaining({ id: "minimax", method: "api_key" }),
			]),
		);
	});

	test("resolves supported providers by id", () => {
		expect(getSupportedAuthProvider("anthropic")).toEqual(
			expect.objectContaining({ id: "anthropic", method: "oauth" }),
		);
		expect(getSupportedAuthProvider("openai-codex")).toEqual(
			expect.objectContaining({ id: "openai-codex", method: "oauth" }),
		);
		expect(getSupportedAuthProvider("minimax")).toEqual(
			expect.objectContaining({ id: "minimax", method: "api_key" }),
		);
		expect(getSupportedAuthProvider("does-not-exist")).toBeUndefined();
	});

	test("reports configured providers with credential type", () => {
		const auth = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		setApiKeyCredential(auth, "minimax", "mini-secret");

		const summaries = getConfiguredAuthProviderSummaries(auth);
		expect(summaries).toEqual([
			{ id: "anthropic", configured: true, credentialType: "oauth" },
			{ id: "minimax", configured: true, credentialType: "api_key" },
		]);
	});
});
