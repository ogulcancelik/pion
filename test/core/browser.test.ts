import { describe, expect, test } from "bun:test";
import { getBrowserOpenCommand, openUrlInBrowserWithSpawn } from "../../src/core/browser.js";

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

describe("openUrlInBrowserWithSpawn", () => {
	test("returns false when the browser opener cannot be spawned", () => {
		const result = openUrlInBrowserWithSpawn("https://example.com", "linux", () => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		expect(result).toBe(false);
	});

	test("attaches an error handler so missing desktop openers do not crash later", () => {
		let errorHandler: ((error: Error) => void) | undefined;
		const result = openUrlInBrowserWithSpawn("https://example.com", "linux", () => ({
			on(event: string, handler: (error: Error) => void) {
				if (event === "error") {
					errorHandler = handler;
				}
				return this;
			},
			unref() {},
		}));

		expect(result).toBe(true);
		expect(errorHandler).toBeDefined();
		expect(() => errorHandler?.(new Error("xdg-open missing"))).not.toThrow();
	});
});
