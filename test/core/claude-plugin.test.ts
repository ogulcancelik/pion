import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { WEB_BROWSE_PACKAGE, ensureClaudePlugin } from "../../src/core/claude-plugin.js";

function fakePackageManager(installedPath?: string): PackageManager {
	return {
		getInstalledPath: (source: string) =>
			source === WEB_BROWSE_PACKAGE ? (installedPath ?? null) : null,
	} as unknown as PackageManager;
}

function writeSkill(dir: string, name: string): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
	return skillDir;
}

describe("ensureClaudePlugin", () => {
	const testDir = join(tmpdir(), "pion-claude-plugin-test");
	const dataDir = join(testDir, "data");
	const skillsDir = join(dataDir, "skills");

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("links pion skills and writes the plugin manifest", () => {
		writeSkill(skillsDir, "my-skill");

		const pluginPath = ensureClaudePlugin({
			dataDir,
			packageManager: fakePackageManager(),
		});

		expect(pluginPath).toBe(join(dataDir, "claude-plugin"));
		const manifest = JSON.parse(
			readFileSync(join(dataDir, "claude-plugin", ".claude-plugin", "plugin.json"), "utf-8"),
		);
		expect(manifest.name).toBe("pion");

		const link = join(dataDir, "claude-plugin", "skills", "my-skill");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toContain("my-skill");
	});

	test("links the installed pi-web-browse package as a skill", () => {
		const packageDir = join(testDir, "packages", "pi-web-browse");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "SKILL.md"), "---\nname: pi-web-browse\n---\n");

		const pluginPath = ensureClaudePlugin({
			dataDir,
			packageManager: fakePackageManager(packageDir),
		});

		expect(pluginPath).toBeDefined();
		const link = join(dataDir, "claude-plugin", "skills", "pi-web-browse");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	test("returns undefined when there is nothing to share", () => {
		const pluginPath = ensureClaudePlugin({
			dataDir,
			packageManager: fakePackageManager(),
		});
		expect(pluginPath).toBeUndefined();
	});

	test("rebuild drops links to removed skills", () => {
		writeSkill(skillsDir, "old-skill");
		ensureClaudePlugin({ dataDir, packageManager: fakePackageManager() });
		rmSync(join(skillsDir, "old-skill"), { recursive: true, force: true });
		writeSkill(skillsDir, "new-skill");

		ensureClaudePlugin({ dataDir, packageManager: fakePackageManager() });

		const skillsRoot = join(dataDir, "claude-plugin", "skills");
		expect(existsSync(join(skillsRoot, "old-skill"))).toBe(false);
		expect(lstatSync(join(skillsRoot, "new-skill")).isSymbolicLink()).toBe(true);
	});

	test("ignores directories without SKILL.md", () => {
		mkdirSync(join(skillsDir, "not-a-skill"), { recursive: true });

		const pluginPath = ensureClaudePlugin({
			dataDir,
			packageManager: fakePackageManager(),
		});
		expect(pluginPath).toBeUndefined();
	});
});
