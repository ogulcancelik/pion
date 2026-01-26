import { describe, expect, test } from "bun:test";
import { expandTilde, homeDir } from "../../src/core/paths.js";

describe("homeDir", () => {
	test("returns a non-empty string", () => {
		const home = homeDir();
		expect(home).toBeString();
		expect(home.length).toBeGreaterThan(0);
	});

	test("does not return ~", () => {
		expect(homeDir()).not.toBe("~");
	});
});

describe("expandTilde", () => {
	test("expands ~/path to home dir", () => {
		const result = expandTilde("~/foo/bar");
		expect(result).toBe(`${homeDir()}/foo/bar`);
	});

	test("expands bare ~", () => {
		const result = expandTilde("~");
		expect(result).toBe(homeDir());
	});

	test("does not expand ~ in the middle of a path", () => {
		const result = expandTilde("/some/~path");
		expect(result).toBe("/some/~path");
	});

	test("returns absolute paths unchanged", () => {
		expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
	});

	test("returns relative paths unchanged", () => {
		expect(expandTilde("relative/path")).toBe("relative/path");
	});
});
