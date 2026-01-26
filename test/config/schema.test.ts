import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/config/schema.js";

describe("validateConfig", () => {
	test("rejects non-object config", () => {
		expect(validateConfig(null)).toContain("Config must be an object");
		expect(validateConfig("string")).toContain("Config must be an object");
	});

	test("requires agents object", () => {
		const errors = validateConfig({ routes: [] });
		expect(errors).toContain("Config must have 'agents' object");
	});

	test("requires routes array", () => {
		const errors = validateConfig({ agents: {} });
		expect(errors).toContain("Config must have 'routes' array");
	});

	test("validates route agent references", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [{ match: { type: "dm" }, agent: "nonexistent", isolation: "per-chat" }],
		});
		expect(errors).toContain("Route references unknown agent: nonexistent");
	});

	test("accepts valid config", () => {
		const errors = validateConfig({
			agents: {
				main: { model: "anthropic/claude-sonnet-4-20250514", systemPrompt: "Hello" },
			},
			routes: [{ match: { type: "dm" }, agent: "main", isolation: "per-contact" }],
		});
		expect(errors).toHaveLength(0);
	});

	test("accepts null agent in route", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [{ match: { type: "group" }, agent: null, isolation: "per-chat" }],
		});
		expect(errors).toHaveLength(0);
	});
});
