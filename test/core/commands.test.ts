import { describe, expect, test } from "bun:test";
import { type ActionMessage } from "../../src/providers/types.js";
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

	describe("fromAction", () => {
		function makeAction(actionId: string): ActionMessage {
			return {
				id: "action-1",
				chatId: "chat-1",
				senderId: "user-1",
				provider: "telegram",
				timestamp: new Date("2026-04-02T22:00:00.000Z"),
				isGroup: false,
				actionId,
				raw: {},
			};
		}

		test("maps stop action to stop command", () => {
			expect(commands.fromAction(makeAction("stop"))).toEqual({ command: "stop", args: "" });
		});

		test("maps new action to new command", () => {
			expect(commands.fromAction(makeAction("new"))).toEqual({ command: "new", args: "" });
		});

		test("maps compact action to compact command", () => {
			expect(commands.fromAction(makeAction("compact"))).toEqual({
				command: "compact",
				args: "",
			});
		});

		test("ignores unsupported action ids", () => {
			expect(commands.fromAction(makeAction("inspect"))).toBeNull();
			expect(commands.fromAction(makeAction("weird"))).toBeNull();
		});
	});
});
