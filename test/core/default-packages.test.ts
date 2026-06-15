import { describe, expect, test } from "bun:test";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { ensureDefaultPackages } from "../../src/core/default-packages.js";

/** Minimal fake PackageManager recording installs. */
function fakePm(installed: Set<string>, opts: { failOn?: string } = {}) {
	const calls: string[] = [];
	const pm = {
		getInstalledPath: (source: string) => (installed.has(source) ? `/fake/${source}` : undefined),
		installAndPersist: async (source: string) => {
			if (opts.failOn === source) throw new Error("boom");
			calls.push(source);
			installed.add(source);
		},
	} as unknown as PackageManager;
	return { pm, calls };
}

describe("ensureDefaultPackages", () => {
	test("installs packages that are missing", async () => {
		const { pm, calls } = fakePm(new Set());
		await ensureDefaultPackages("/cwd", "/agent", {
			packageManager: pm,
			packages: ["a/one", "b/two"],
		});
		expect(calls).toEqual(["a/one", "b/two"]);
	});

	test("skips packages already installed", async () => {
		const { pm, calls } = fakePm(new Set(["a/one"]));
		await ensureDefaultPackages("/cwd", "/agent", {
			packageManager: pm,
			packages: ["a/one", "b/two"],
		});
		expect(calls).toEqual(["b/two"]);
	});

	test("is non-fatal when an install fails", async () => {
		const logs: string[] = [];
		const { pm, calls } = fakePm(new Set(), { failOn: "a/one" });
		await ensureDefaultPackages("/cwd", "/agent", {
			packageManager: pm,
			packages: ["a/one", "b/two"],
			log: (m) => logs.push(m),
		});
		// a/one failed but b/two still installed; no throw.
		expect(calls).toEqual(["b/two"]);
		expect(logs.some((l) => l.includes("a/one"))).toBe(true);
	});
});
