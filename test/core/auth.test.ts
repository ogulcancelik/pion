import { describe, expect, test } from "bun:test";
import { getAuthPath, getDefaultAuthPath } from "../../src/core/auth.js";
import { homeDir } from "../../src/core/paths.js";

describe("auth path helpers", () => {
	test("default auth path points to pion auth store", () => {
		expect(getDefaultAuthPath()).toBe(`${homeDir()}/.pion/auth.json`);
	});

	test("getAuthPath uses config override when provided", () => {
		expect(getAuthPath({ authPath: "~/.custom/auth.json" })).toBe(`${homeDir()}/.custom/auth.json`);
	});

	test("getAuthPath falls back to pion auth store", () => {
		expect(getAuthPath()).toBe(`${homeDir()}/.pion/auth.json`);
	});
});
