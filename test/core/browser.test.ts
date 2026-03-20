import { describe, expect, test } from "bun:test";
import { getBrowserOpenCommand } from "../../src/core/browser.js";

describe("getBrowserOpenCommand", () => {
	test("returns open on darwin", () => {
		expect(getBrowserOpenCommand("darwin")).toEqual({
			command: "open",
			args: ["https://example.com"],
		});
	});

	test("returns cmd start on win32", () => {
		expect(getBrowserOpenCommand("win32")).toEqual({
			command: "cmd",
			args: ["/c", "start", "", "https://example.com"],
		});
	});

	test("returns xdg-open on linux", () => {
		expect(getBrowserOpenCommand("linux")).toEqual({
			command: "xdg-open",
			args: ["https://example.com"],
		});
	});
});
