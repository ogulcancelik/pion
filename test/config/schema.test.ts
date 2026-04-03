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

	test("accepts valid debounceMs values", () => {
		const base = {
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		};

		expect(validateConfig({ ...base, debounceMs: 0 })).toHaveLength(0);
		expect(validateConfig({ ...base, debounceMs: 3000 })).toHaveLength(0);
		expect(validateConfig({ ...base, debounceMs: 500 })).toHaveLength(0);
	});

	test("rejects negative debounceMs", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
			debounceMs: -1,
		});
		expect(errors).toContain("debounceMs must be non-negative");
	});

	test("rejects non-numeric debounceMs", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
			debounceMs: "3000",
		});
		expect(errors).toContain("debounceMs must be a finite number");
	});

	test("rejects Infinity debounceMs", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
			debounceMs: Number.POSITIVE_INFINITY,
		});
		expect(errors).toContain("debounceMs must be a finite number");
	});

	test("accepts config without debounceMs (uses default)", () => {
		const errors = validateConfig({
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toHaveLength(0);
	});

	test("accepts global recallQueryModel when it is a string", () => {
		const errors = validateConfig({
			recallQueryModel: "anthropic/claude-haiku-4-5",
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toHaveLength(0);
	});

	test("rejects non-string global recallQueryModel", () => {
		const errors = validateConfig({
			recallQueryModel: 123,
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toContain("recallQueryModel must be a string");
	});

	test("accepts agent cwd override when it is a string", () => {
		const errors = validateConfig({
			agents: {
				main: {
					model: "x",
					systemPrompt: "y",
					workspace: "/tmp/pion/agents/main",
					cwd: "/tmp/project",
				},
			},
			routes: [],
		});
		expect(errors).toHaveLength(0);
	});

	test("rejects non-string agent cwd override", () => {
		const errors = validateConfig({
			agents: {
				main: {
					model: "x",
					systemPrompt: "y",
					workspace: "/tmp/pion/agents/main",
					cwd: 123,
				},
			},
			routes: [],
		});
		expect(errors).toContain("agents.main.cwd must be a string");
	});

	test("accepts telegram status clearOnComplete flag", () => {
		const errors = validateConfig({
			telegram: {
				botToken: "token",
				status: {
					clearOnComplete: false,
				},
			},
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toHaveLength(0);
	});

	test("rejects non-boolean telegram status clearOnComplete flag", () => {
		const errors = validateConfig({
			telegram: {
				botToken: "token",
				status: {
					clearOnComplete: "nope",
				},
			},
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toContain("telegram.status.clearOnComplete must be a boolean");
	});

	test("accepts cron agent defaults", () => {
		const errors = validateConfig({
			cron: {
				agent: {
					model: "anthropic/claude-haiku-4-5",
					workspace: "/tmp/pion/agents/cron",
					skills: ["web-browse"],
				},
			},
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toHaveLength(0);
	});

	test("rejects non-object cron agent defaults", () => {
		const errors = validateConfig({
			cron: {
				agent: "haiku",
			},
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toContain("cron.agent must be an object");
	});

	test("rejects non-string cron agent model", () => {
		const errors = validateConfig({
			cron: {
				agent: {
					model: 123,
					workspace: "/tmp/pion/agents/cron",
				},
			},
			agents: { main: { model: "x", systemPrompt: "y" } },
			routes: [],
		});
		expect(errors).toContain("cron.agent.model must be a string");
	});
});
