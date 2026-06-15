import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { AgentProfileStore } from "../../src/core/agent-profiles.js";
import {
	DEFAULT_PEER_TOOLS,
	type PeerRequest,
	type PeerResult,
	type RunPeer,
	type SubagentDetails,
	buildPeerSpawnEnv,
	createSubagentTool,
} from "../../src/core/subagent.js";

type SubagentResult = AgentToolResult<SubagentDetails>;

/** A fake runPeer that records its requests and returns a canned result. */
function fakeRunPeer(
	result: PeerResult = { response: "peer reply" },
): RunPeer & { calls: Array<{ request: PeerRequest; signal?: AbortSignal }> } {
	const calls: Array<{ request: PeerRequest; signal?: AbortSignal }> = [];
	const fn = (async (request, signal) => {
		calls.push({ request, signal });
		return result;
	}) as RunPeer & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

type SubagentTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: never,
	) => Promise<SubagentResult>;
};

function getTool(runPeer: RunPeer, defaultModel?: string): SubagentTool {
	return createSubagentTool({
		runPeer,
		defaultModel,
	}) as unknown as SubagentTool;
}

function run(
	tool: SubagentTool,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<SubagentResult> {
	return tool.execute("c1", params, signal, undefined, {} as never);
}

function textOf(result: SubagentResult): string {
	return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("subagent", () => {
	test("builds the peer request and passes the reply through", async () => {
		const runPeer = fakeRunPeer({ response: "the answer is 42" });
		const tool = getTool(runPeer);

		const result = await run(tool, {
			task: "What is the answer?",
			model: "openai/gpt-5.5",
			tools: "read,bash",
		});

		expect(runPeer.calls).toHaveLength(1);
		expect(runPeer.calls[0]?.request).toEqual({
			provider: "openai",
			modelId: "gpt-5.5",
			tools: "read,bash",
			task: "What is the answer?",
		});
		expect(textOf(result)).toBe("the answer is 42");
		expect(result.details?.error).toBeUndefined();
		expect(result.details?.model).toBe("openai/gpt-5.5");
	});

	test("defaults tools to read-only", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer);

		await run(tool, { task: "investigate", model: "openai/gpt-5.5" });

		expect(runPeer.calls[0]?.request.tools).toBe(DEFAULT_PEER_TOOLS);
	});

	test("falls back to the configured default model when model is omitted", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer, "anthropic/claude-opus-4-8");

		await run(tool, { task: "second opinion" });

		expect(runPeer.calls[0]?.request.provider).toBe("anthropic");
		expect(runPeer.calls[0]?.request.modelId).toBe("claude-opus-4-8");
	});

	test("an explicit model overrides the default", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer, "anthropic/claude-opus-4-8");

		await run(tool, { task: "go", model: "openai/gpt-5.5" });

		expect(runPeer.calls[0]?.request.provider).toBe("openai");
		expect(runPeer.calls[0]?.request.modelId).toBe("gpt-5.5");
	});

	test("errors cleanly when no model is available", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "no model here" });

		expect(runPeer.calls).toHaveLength(0);
		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("No peer model");
	});

	test("errors cleanly on a malformed model string", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "go", model: "gpt-5.5" });

		expect(runPeer.calls).toHaveLength(0);
		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("Invalid model");
	});

	test("errors cleanly on an empty task", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "   ", model: "openai/gpt-5.5" });

		expect(runPeer.calls).toHaveLength(0);
		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("must not be empty");
	});

	test("surfaces a peer error (e.g. non-zero exit) as a tool error", async () => {
		const runPeer = fakeRunPeer({ response: "", error: "peer exited unexpectedly (code=1)" });
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "go", model: "openai/gpt-5.5" });

		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("peer exited unexpectedly");
	});

	test("treats an empty peer reply as an error", async () => {
		const runPeer = fakeRunPeer({ response: "   " });
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "go", model: "openai/gpt-5.5" });

		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("empty reply");
	});

	test("does not throw when runPeer rejects", async () => {
		const runPeer = (async () => {
			throw new Error("boom");
		}) as RunPeer;
		const tool = getTool(runPeer);

		const result = await run(tool, { task: "go", model: "openai/gpt-5.5" });

		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("boom");
	});

	test("passes the abort signal through to runPeer", async () => {
		const runPeer = fakeRunPeer();
		const tool = getTool(runPeer);
		const controller = new AbortController();

		await run(tool, { task: "go", model: "openai/gpt-5.5" }, controller.signal);

		expect(runPeer.calls[0]?.signal).toBe(controller.signal);
	});

	test("an already-aborted signal yields an aborted error from the default runner", async () => {
		// Use the real default runner but abort before it can spawn anything.
		const tool = createSubagentTool({}) as unknown as SubagentTool;
		const controller = new AbortController();
		controller.abort();

		const result = await run(tool, { task: "go", model: "openai/gpt-5.5" }, controller.signal);

		expect(result.details?.error).toBe(true);
		expect(textOf(result)).toContain("aborted");
	});
});

describe("buildPeerSpawnEnv", () => {
	test("points PI_CODING_AGENT_DIR at the given config dir so the peer uses pion's auth", () => {
		const env = buildPeerSpawnEnv("/home/x/.pion");
		expect(env.PI_CODING_AGENT_DIR).toBe("/home/x/.pion");
	});

	test("leaves the inherited env untouched when no config dir is given", () => {
		const env = buildPeerSpawnEnv(undefined);
		expect(env.PI_CODING_AGENT_DIR).toBe(process.env.PI_CODING_AGENT_DIR);
	});
});

describe("subagent profile resolution", () => {
	let dir: string;
	let store: AgentProfileStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pion-subagent-profiles-"));
		store = new AgentProfileStore(join(dir, "agent-profiles.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function toolWithProfiles(runPeer: RunPeer): SubagentTool {
		return createSubagentTool({ runPeer, profiles: store }) as unknown as SubagentTool;
	}

	test("resolves a saved profile alias to its model, tools, and instructions", async () => {
		store.save({
			name: "simulation",
			model: "google/gemini-2.5-pro",
			tools: "read,web_fetch",
			systemPrompt: "Run sims.",
		});
		const runPeer = fakeRunPeer({ response: "ok" });
		const result = await run(toolWithProfiles(runPeer), { task: "go", model: "simulation" });

		const req = runPeer.calls[0]?.request;
		expect(req?.provider).toBe("google");
		expect(req?.modelId).toBe("gemini-2.5-pro");
		expect(req?.tools).toBe("read,web_fetch");
		expect(req?.task).toContain("Run sims.");
		expect(req?.task).toContain("go");
		expect(result.details?.model).toBe("google/gemini-2.5-pro");
	});

	test("an explicit tools arg overrides the profile's tools", async () => {
		store.save({ name: "sim", model: "google/gemini-2.5-pro", tools: "read" });
		const runPeer = fakeRunPeer();
		await run(toolWithProfiles(runPeer), { task: "go", model: "sim", tools: "bash,read" });
		expect(runPeer.calls[0]?.request.tools).toBe("bash,read");
	});

	test("a model that is not a saved profile is treated as provider/id", async () => {
		const runPeer = fakeRunPeer();
		await run(toolWithProfiles(runPeer), { task: "go", model: "openai/gpt-5.5" });
		expect(runPeer.calls[0]?.request.provider).toBe("openai");
		expect(runPeer.calls[0]?.request.modelId).toBe("gpt-5.5");
	});

	test("an unknown alias that is not provider/id errors without running the peer", async () => {
		const runPeer = fakeRunPeer();
		const result = await run(toolWithProfiles(runPeer), { task: "go", model: "ghost" });
		expect(result.details?.error).toBe(true);
		expect(runPeer.calls).toHaveLength(0);
	});
});
