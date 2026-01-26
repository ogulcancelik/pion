import { describe, expect, test } from "bun:test";
import { type CommandMatch, Commands } from "../../src/core/commands.js";

describe("Commands", () => {
	const commands = new Commands();

	describe("parse", () => {
		test("returns null for regular messages", () => {
			expect(commands.parse("hello there")).toBeNull();
			expect(commands.parse("what's new?")).toBeNull();
			expect(commands.parse("let's compact this idea")).toBeNull();
		});

		test("parses /new command", () => {
			const result = commands.parse("/new");
			expect(result).toEqual({ command: "new", args: "" });
		});

		test("parses /new with extra whitespace", () => {
			const result = commands.parse("  /new  ");
			expect(result).toEqual({ command: "new", args: "" });
		});

		test("parses /compact without args", () => {
			const result = commands.parse("/compact");
			expect(result).toEqual({ command: "compact", args: "" });
		});

		test("parses /compact with focus args", () => {
			const result = commands.parse("/compact focus on the API design");
			expect(result).toEqual({ command: "compact", args: "focus on the API design" });
		});

		test("parses /compact with 'but' style args", () => {
			const result = commands.parse("/compact but focus on last work on router");
			expect(result).toEqual({ command: "compact", args: "but focus on last work on router" });
		});

		test("is case insensitive", () => {
			expect(commands.parse("/NEW")).toEqual({ command: "new", args: "" });
			expect(commands.parse("/Compact")).toEqual({ command: "compact", args: "" });
		});

		test("ignores unknown commands", () => {
			expect(commands.parse("/unknown")).toBeNull();
			expect(commands.parse("/help")).toBeNull();
		});
	});
});
