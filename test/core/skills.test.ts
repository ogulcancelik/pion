import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../../src/core/skills.js";

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
		expect(result.skills[0]?.name).toBe("web-browse");
		expect(result.skills[0]?.description).toBe("Browse the web using a headless browser");
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
