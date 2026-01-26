import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMemoryDir, loadWorkspace } from "../../src/core/workspace.js";

describe("loadWorkspace - full file loading", () => {
	const testDir = "/tmp/pion-test-workspace-full";

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("loads AGENTS.md", () => {
		writeFileSync(join(testDir, "AGENTS.md"), "# Workspace rules");
		const content = loadWorkspace(testDir);
		expect(content.agents).toBe("# Workspace rules");
	});

	test("loads all core files", () => {
		writeFileSync(join(testDir, "SOUL.md"), "soul content");
		writeFileSync(join(testDir, "IDENTITY.md"), "identity content");
		writeFileSync(join(testDir, "AGENTS.md"), "agents content");
		writeFileSync(join(testDir, "USER.md"), "user content");
		writeFileSync(join(testDir, "MEMORY.md"), "memory content");

		const content = loadWorkspace(testDir);

		expect(content.soul).toBe("soul content");
		expect(content.identity).toBe("identity content");
		expect(content.agents).toBe("agents content");
		expect(content.user).toBe("user content");
		expect(content.memory).toBe("memory content");
	});
});

describe("loadMemoryDir", () => {
	const testDir = "/tmp/pion-test-memory-dir";
	const memoryDir = join(testDir, "memory");

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(memoryDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty array if memory dir doesn't exist", () => {
		rmSync(memoryDir, { recursive: true, force: true });
		const files = loadMemoryDir(testDir);
		expect(files).toEqual([]);
	});

	test("loads all .md files from memory/", () => {
		writeFileSync(join(memoryDir, "2026-01-25.md"), "day 1 notes");
		writeFileSync(join(memoryDir, "2026-01-26.md"), "day 2 notes");
		writeFileSync(join(memoryDir, "learnings.md"), "stuff I learned");

		const files = loadMemoryDir(testDir);

		expect(files).toHaveLength(3);
		expect(files.map((f) => f.name).sort()).toEqual([
			"2026-01-25.md",
			"2026-01-26.md",
			"learnings.md",
		]);
	});

	test("ignores non-.md files", () => {
		writeFileSync(join(memoryDir, "notes.md"), "real notes");
		writeFileSync(join(memoryDir, "image.png"), "not markdown");
		writeFileSync(join(memoryDir, "data.json"), "{}");

		const files = loadMemoryDir(testDir);

		expect(files).toHaveLength(1);
		expect(files[0]?.name).toBe("notes.md");
	});

	test("returns files sorted by name", () => {
		writeFileSync(join(memoryDir, "zebra.md"), "z");
		writeFileSync(join(memoryDir, "alpha.md"), "a");
		writeFileSync(join(memoryDir, "middle.md"), "m");

		const files = loadMemoryDir(testDir);

		expect(files.map((f) => f.name)).toEqual(["alpha.md", "middle.md", "zebra.md"]);
	});
});
