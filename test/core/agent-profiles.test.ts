import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileStore } from "../../src/core/agent-profiles.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pion-profiles-"));
	file = join(dir, "agent-profiles.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("AgentProfileStore.save", () => {
	test("creates a profile, stamps timestamps, and persists to disk", () => {
		const store = new AgentProfileStore(file);
		const saved = store.save({ name: "simulation", model: "google/gemini-2.5-pro" });

		expect(saved.name).toBe("simulation");
		expect(saved.model).toBe("google/gemini-2.5-pro");
		expect(saved.createdAt).toBeTruthy();
		expect(saved.updatedAt).toBe(saved.createdAt);

		// Persisted and readable by a fresh store instance.
		expect(new AgentProfileStore(file).get("simulation")?.model).toBe("google/gemini-2.5-pro");
	});

	test("keeps optional fields (tools, systemPrompt, thinkingLevel, skills)", () => {
		const store = new AgentProfileStore(file);
		const saved = store.save({
			name: "researcher",
			model: "openai/gpt-5.5",
			tools: "read,grep,web_fetch",
			systemPrompt: "You research carefully.",
			thinkingLevel: "high",
			skills: ["web-browse"],
		});
		expect(saved.tools).toBe("read,grep,web_fetch");
		expect(saved.systemPrompt).toBe("You research carefully.");
		expect(saved.thinkingLevel).toBe("high");
		expect(saved.skills).toEqual(["web-browse"]);
	});

	test("updating an existing profile preserves createdAt and bumps updatedAt", async () => {
		const store = new AgentProfileStore(file);
		const first = store.save({ name: "sim", model: "google/gemini-2.5-pro" });
		await new Promise((r) => setTimeout(r, 5));
		const second = store.save({ name: "sim", model: "minimax/minimax-m2" });

		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt >= first.updatedAt).toBe(true);
		expect(second.model).toBe("minimax/minimax-m2");
		expect(store.list()).toHaveLength(1);
	});

	test("rejects an empty name", () => {
		const store = new AgentProfileStore(file);
		expect(() => store.save({ name: "  ", model: "google/gemini-2.5-pro" })).toThrow();
	});

	test('rejects a model that is not "provider/id"', () => {
		const store = new AgentProfileStore(file);
		expect(() => store.save({ name: "x", model: "gemini" })).toThrow();
		expect(() => store.save({ name: "x", model: "/id" })).toThrow();
		expect(() => store.save({ name: "x", model: "provider/" })).toThrow();
	});
});

describe("AgentProfileStore.get / list / delete", () => {
	test("get returns undefined for an unknown profile", () => {
		expect(new AgentProfileStore(file).get("nope")).toBeUndefined();
	});

	test("list returns profiles sorted by name", () => {
		const store = new AgentProfileStore(file);
		store.save({ name: "zeta", model: "a/b" });
		store.save({ name: "alpha", model: "a/b" });
		expect(store.list().map((p) => p.name)).toEqual(["alpha", "zeta"]);
	});

	test("delete removes a profile and reports whether it existed", () => {
		const store = new AgentProfileStore(file);
		store.save({ name: "sim", model: "a/b" });
		expect(store.delete("sim")).toBe(true);
		expect(store.get("sim")).toBeUndefined();
		expect(store.delete("sim")).toBe(false);
	});
});

describe("AgentProfileStore persistence edge cases", () => {
	test("a missing file yields an empty store", () => {
		expect(new AgentProfileStore(file).list()).toEqual([]);
	});

	test("a malformed file yields an empty store rather than throwing", () => {
		writeFileSync(file, "{ not json", "utf-8");
		expect(new AgentProfileStore(file).list()).toEqual([]);
	});

	test("save writes valid JSON keyed by profile name", () => {
		const store = new AgentProfileStore(file);
		store.save({ name: "sim", model: "google/gemini-2.5-pro" });
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		expect(parsed.sim.model).toBe("google/gemini-2.5-pro");
	});
});
