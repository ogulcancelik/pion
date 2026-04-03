import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../src/config/schema.js";
import {
	buildSystemPrompt,
	ensureWorkspace,
	loadWorkspace,
	resolveAgentCwd,
} from "../../src/core/workspace.js";

describe("loadWorkspace", () => {
	const testDir = "/tmp/pion-test-workspace";

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("loads SOUL.md when present", () => {
		writeFileSync(join(testDir, "SOUL.md"), "# Soul\nBe helpful.");
		const content = loadWorkspace(testDir);
		expect(content.soul).toBe("# Soul\nBe helpful.");
	});

	test("loads all workspace files", () => {
		writeFileSync(join(testDir, "SOUL.md"), "soul content");
		writeFileSync(join(testDir, "IDENTITY.md"), "identity content");
		writeFileSync(join(testDir, "USER.md"), "user content");
		writeFileSync(join(testDir, "MEMORY.md"), "memory content");

		const content = loadWorkspace(testDir);

		expect(content.soul).toBe("soul content");
		expect(content.identity).toBe("identity content");
		expect(content.user).toBe("user content");
		expect(content.memory).toBe("memory content");
	});

	test("returns undefined for missing files", () => {
		const content = loadWorkspace(testDir);
		expect(content.soul).toBeUndefined();
		expect(content.identity).toBeUndefined();
	});
});

describe("buildSystemPrompt", () => {
	const testDir = "/tmp/pion-test-prompt";

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("includes workspace files in order", () => {
		writeFileSync(join(testDir, "SOUL.md"), "SOUL");
		writeFileSync(join(testDir, "IDENTITY.md"), "IDENTITY");

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: testDir,
		};

		const prompt = buildSystemPrompt(config);

		// Soul should come before Identity
		expect(prompt.indexOf("SOUL")).toBeLessThan(prompt.indexOf("IDENTITY"));
	});

	test("includes inline systemPrompt", () => {
		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: testDir,
			systemPrompt: "Be concise.",
		};

		const prompt = buildSystemPrompt(config);
		expect(prompt).toContain("Be concise.");
	});

	// NOTE: Runtime context (time, context %) is now in user message prefix
	// (see runner.ts) to keep system prompt cacheable
});

describe("resolveAgentCwd", () => {
	test("defaults execution cwd to workspace", () => {
		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion-agent",
		};

		expect(resolveAgentCwd(config)).toBe("/tmp/pion-agent");
	});

	test("prefers explicit cwd override", () => {
		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: "/tmp/pion-agent",
			cwd: "/tmp/project",
		};

		expect(resolveAgentCwd(config)).toBe("/tmp/project");
	});
});

describe("ensureWorkspace", () => {
	const testDir = "/tmp/pion-test-ensure";

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("creates directory and default SOUL.md", () => {
		ensureWorkspace(testDir);

		expect(existsSync(testDir)).toBe(true);
		expect(existsSync(join(testDir, "SOUL.md"))).toBe(true);
	});

	test("does not overwrite existing SOUL.md", () => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "SOUL.md"), "custom soul");

		ensureWorkspace(testDir);

		const { readFileSync } = require("node:fs");
		expect(readFileSync(join(testDir, "SOUL.md"), "utf-8")).toBe("custom soul");
	});
});
