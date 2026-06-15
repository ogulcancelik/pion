import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentProfileStore } from "../../src/core/agent-profiles.js";
import { createProfileTools } from "../../src/core/profile-tools.js";

let dir: string;
let store: AgentProfileStore;
let tools: ToolDefinition[];

function tool(name: string): ToolDefinition {
	const found = tools.find((t) => t.name === name);
	if (!found) throw new Error(`tool ${name} missing`);
	return found;
}

const ctx = {} as ExtensionContext;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pion-profile-tools-"));
	store = new AgentProfileStore(join(dir, "agent-profiles.json"));
	tools = createProfileTools(store);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("save_subagent", () => {
	test("saves a profile to the store and confirms it", async () => {
		const result = await tool("save_subagent").execute(
			"c1",
			{ name: "simulation", model: "google/gemini-2.5-pro" },
			undefined,
			undefined,
			ctx,
		);
		expect(store.get("simulation")?.model).toBe("google/gemini-2.5-pro");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("simulation");
		expect(text).toContain("google/gemini-2.5-pro");
	});

	test("persists tools and instructions", async () => {
		await tool("save_subagent").execute(
			"c1",
			{
				name: "researcher",
				model: "openai/gpt-5.5",
				tools: "read,web_fetch",
				instructions: "Be rigorous.",
			},
			undefined,
			undefined,
			ctx,
		);
		const saved = store.get("researcher");
		expect(saved?.tools).toBe("read,web_fetch");
		expect(saved?.systemPrompt).toBe("Be rigorous.");
	});

	test("returns an error result (no throw) for an invalid model and saves nothing", async () => {
		const result = await tool("save_subagent").execute(
			"c1",
			{ name: "bad", model: "gemini" },
			undefined,
			undefined,
			ctx,
		);
		expect((result.details as { error?: boolean }).error).toBe(true);
		expect(store.get("bad")).toBeUndefined();
	});

	test("returns an error result for an empty name", async () => {
		const result = await tool("save_subagent").execute(
			"c1",
			{ name: "   ", model: "a/b" },
			undefined,
			undefined,
			ctx,
		);
		expect((result.details as { error?: boolean }).error).toBe(true);
	});
});

describe("list_subagents", () => {
	test("lists saved profiles with their models", async () => {
		store.save({ name: "alpha", model: "a/one" });
		store.save({ name: "zeta", model: "z/two" });
		const result = await tool("list_subagents").execute("c1", {}, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("alpha");
		expect(text).toContain("a/one");
		expect(text).toContain("zeta");
	});

	test("reports when there are no saved profiles", async () => {
		const result = await tool("list_subagents").execute("c1", {}, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.toLowerCase()).toContain("no");
	});
});
