import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDefaultSkills } from "../../src/core/default-skills.js";

describe("ensureDefaultSkills", () => {
	const testDir = join(tmpdir(), "pion-default-skills-test");
	const sourceRoot = join(testDir, "source");
	const dataDir = join(testDir, "data");

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(join(sourceRoot, "pi-speech-to-text"), { recursive: true });
		writeFileSync(
			join(sourceRoot, "pi-speech-to-text", "SKILL.md"),
			"---\nname: pi-speech-to-text\ndescription: Transcribe local audio\n---\n",
		);
		writeFileSync(
			join(sourceRoot, "pi-speech-to-text", "speech-to-text.js"),
			"#!/usr/bin/env node\n",
		);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("copies bundled skills into the Pion skills directory when missing", () => {
		ensureDefaultSkills({ dataDir, sourceRoot, skills: ["pi-speech-to-text"] });

		const target = join(dataDir, "skills", "pi-speech-to-text");
		expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toContain("pi-speech-to-text");
		expect(existsSync(join(target, "speech-to-text.js"))).toBe(true);
	});

	test("does not overwrite an existing user skill", () => {
		const target = join(dataDir, "skills", "pi-speech-to-text");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "custom skill");

		ensureDefaultSkills({ dataDir, sourceRoot, skills: ["pi-speech-to-text"] });

		expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("custom skill");
	});

	test("logs and continues when a bundled skill source is missing", () => {
		const logs: string[] = [];

		expect(() =>
			ensureDefaultSkills({
				dataDir,
				sourceRoot,
				skills: ["missing-skill"],
				log: (message) => logs.push(message),
			}),
		).not.toThrow();
		expect(logs.some((message) => message.includes("missing-skill"))).toBe(true);
	});
});
