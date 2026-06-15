import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendDailyNote,
	createRememberTool,
	dailyDir,
	dailyStem,
} from "../../src/core/memory-tools.js";
import { loadDailyNotes } from "../../src/core/workspace.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pion-memory-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("appendDailyNote", () => {
	test("creates the daily folder and file with a date header on first write", () => {
		const now = new Date(2026, 5, 14, 9, 5); // 2026-06-14 09:05 local
		const file = appendDailyNote(workspace, "User prefers bun over npm", undefined, now);

		expect(file).toBe(join(dailyDir(workspace), "2026-06-14.md"));
		expect(readFileSync(file, "utf-8")).toBe(
			"# 2026-06-14\n\n- 09:05 — User prefers bun over npm\n",
		);
	});

	test("appends subsequent notes to the same day without re-adding the header", () => {
		const morning = new Date(2026, 5, 14, 9, 5);
		const evening = new Date(2026, 5, 14, 21, 30);
		appendDailyNote(workspace, "first", undefined, morning);
		const file = appendDailyNote(workspace, "second", ["pion"], evening);

		expect(readFileSync(file, "utf-8")).toBe(
			"# 2026-06-14\n\n- 09:05 — first\n- 21:30 — second (#pion)\n",
		);
	});

	test("renders multiple tags", () => {
		const now = new Date(2026, 5, 14, 9, 5);
		const file = appendDailyNote(workspace, "note", ["a", "b"], now);
		expect(readFileSync(file, "utf-8")).toContain("- 09:05 — note (#a #b)\n");
	});
});

describe("createRememberTool", () => {
	test("writes a note and reports the file", async () => {
		const now = new Date(2026, 5, 14, 9, 5);
		const tool = createRememberTool({ workspacePath: workspace, now: () => now });

		const result = await tool.execute(
			"call-1",
			{ note: "  trimmed  " },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details?.success).toBe(true);
		expect(result.details?.date).toBe("2026-06-14");
		const file = join(dailyDir(workspace), "2026-06-14.md");
		expect(readFileSync(file, "utf-8")).toContain("— trimmed\n");
	});

	test("rejects an empty note without writing a file", async () => {
		const tool = createRememberTool({ workspacePath: workspace, now: () => new Date(2026, 5, 14) });
		const result = await tool.execute("call-1", { note: "   " }, undefined, undefined, {} as never);

		expect(result.details?.success).toBe(false);
		expect(existsSync(dailyDir(workspace))).toBe(false);
	});
});

describe("loadDailyNotes", () => {
	test("loads all journal files, oldest-first", () => {
		appendDailyNote(workspace, "d1", undefined, new Date(2026, 5, 10, 8, 0));
		appendDailyNote(workspace, "d2", undefined, new Date(2026, 5, 11, 8, 0));
		appendDailyNote(workspace, "d3", undefined, new Date(2026, 5, 12, 8, 0));
		appendDailyNote(workspace, "d4", undefined, new Date(2026, 5, 13, 8, 0));

		const all = loadDailyNotes(workspace);
		expect(all.map((f) => f.name)).toEqual([
			"2026-06-10.md",
			"2026-06-11.md",
			"2026-06-12.md",
			"2026-06-13.md",
		]);
	});

	test("returns empty when no journal exists", () => {
		expect(loadDailyNotes(workspace)).toEqual([]);
	});

	test("dailyStem formats local date", () => {
		expect(dailyStem(new Date(2026, 0, 3, 0, 0))).toBe("2026-01-03");
	});
});
