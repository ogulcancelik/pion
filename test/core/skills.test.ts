import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../src/config/schema.js";
import { buildSystemPromptWithSkills, loadSkills } from "../../src/core/skills.js";

describe("loadSkills", () => {
	const skillsDir = "/tmp/pion-test-skills";

	beforeEach(() => {
		rmSync(skillsDir, { recursive: true, force: true });
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(skillsDir, { recursive: true, force: true });
	});

	test("returns empty array for empty directory", () => {
		const result = loadSkills(skillsDir);
		expect(result.skills).toEqual([]);
	});

	test("returns empty array for non-existent directory", () => {
		const result = loadSkills("/tmp/pion-nonexistent-skills");
		expect(result.skills).toEqual([]);
	});

	test("loads skill with valid SKILL.md", () => {
		const skillDir = join(skillsDir, "web-browse");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: web-browse
description: Browse the web using a headless browser
---

# Web Browse

Instructions for browsing...
`,
		);

		const result = loadSkills(skillsDir);

		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]!.name).toBe("web-browse");
		expect(result.skills[0]!.description).toBe("Browse the web using a headless browser");
	});

	test("loads multiple skills", () => {
		// Skill 1
		const skill1Dir = join(skillsDir, "web-browse");
		mkdirSync(skill1Dir);
		writeFileSync(
			join(skill1Dir, "SKILL.md"),
			`---
name: web-browse
description: Browse the web
---
`,
		);

		// Skill 2
		const skill2Dir = join(skillsDir, "image-gen");
		mkdirSync(skill2Dir);
		writeFileSync(
			join(skill2Dir, "SKILL.md"),
			`---
name: image-gen
description: Generate images
---
`,
		);

		const result = loadSkills(skillsDir);

		expect(result.skills).toHaveLength(2);
		const names = result.skills.map((s) => s.name).sort();
		expect(names).toEqual(["image-gen", "web-browse"]);
	});

	test("skips skills without description", () => {
		const skillDir = join(skillsDir, "broken");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: broken
---

No description in frontmatter
`,
		);

		const result = loadSkills(skillsDir);
		expect(result.skills).toHaveLength(0);
	});

	test("filters skills by name list", () => {
		// Create 3 skills
		for (const name of ["alpha", "beta", "gamma"]) {
			const dir = join(skillsDir, name);
			mkdirSync(dir);
			writeFileSync(
				join(dir, "SKILL.md"),
				`---
name: ${name}
description: Skill ${name}
---
`,
			);
		}

		// Only load alpha and gamma
		const result = loadSkills(skillsDir, ["alpha", "gamma"]);

		expect(result.skills).toHaveLength(2);
		const names = result.skills.map((s) => s.name).sort();
		expect(names).toEqual(["alpha", "gamma"]);
	});
});

describe("buildSystemPromptWithSkills", () => {
	const workspaceDir = "/tmp/pion-test-workspace-skills";
	const skillsDir = "/tmp/pion-test-skills-prompt";

	beforeEach(() => {
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(skillsDir, { recursive: true, force: true });
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(skillsDir, { recursive: true, force: true });
	});

	test("includes skills section in prompt", () => {
		// Create workspace
		writeFileSync(join(workspaceDir, "SOUL.md"), "Be helpful.");

		// Create skill
		const skillDir = join(skillsDir, "web-browse");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: web-browse
description: Browse the web
---
`,
		);

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: workspaceDir,
			skills: ["web-browse"],
		};

		const prompt = buildSystemPromptWithSkills(config, skillsDir);

		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("web-browse");
		expect(prompt).toContain("Browse the web");
		expect(prompt).toContain("</available_skills>");
	});

	test("skills appear after MEMORY.md", () => {
		writeFileSync(join(workspaceDir, "SOUL.md"), "SOUL_MARKER");
		writeFileSync(join(workspaceDir, "MEMORY.md"), "MEMORY_MARKER");

		const skillDir = join(skillsDir, "test-skill");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: test-skill
description: Test skill
---
`,
		);

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: workspaceDir,
			skills: ["test-skill"],
		};

		const prompt = buildSystemPromptWithSkills(config, skillsDir);

		const memoryPos = prompt.indexOf("MEMORY_MARKER");
		const skillsPos = prompt.indexOf("<available_skills>");

		expect(memoryPos).toBeGreaterThan(-1);
		expect(skillsPos).toBeGreaterThan(-1);
		expect(skillsPos).toBeGreaterThan(memoryPos);
	});

	test("no skills section when agent has no skills configured", () => {
		writeFileSync(join(workspaceDir, "SOUL.md"), "Be helpful.");

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: workspaceDir,
			// No skills
		};

		const prompt = buildSystemPromptWithSkills(config, skillsDir);

		expect(prompt).not.toContain("<available_skills>");
	});

	test("no skills section when skills list is empty", () => {
		writeFileSync(join(workspaceDir, "SOUL.md"), "Be helpful.");

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: workspaceDir,
			skills: [],
		};

		const prompt = buildSystemPromptWithSkills(config, skillsDir);

		expect(prompt).not.toContain("<available_skills>");
	});

	test("includes skill file path in prompt", () => {
		writeFileSync(join(workspaceDir, "SOUL.md"), "Be helpful.");

		const skillDir = join(skillsDir, "web-browse");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: web-browse
description: Browse the web
---
`,
		);

		const config: AgentConfig = {
			model: "anthropic/claude-sonnet-4-20250514",
			workspace: workspaceDir,
			skills: ["web-browse"],
		};

		const prompt = buildSystemPromptWithSkills(config, skillsDir);

		// Should include path so agent can read the full skill
		expect(prompt).toContain(join(skillDir, "SKILL.md"));
	});
});
