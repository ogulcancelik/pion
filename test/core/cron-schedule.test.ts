import { describe, expect, test } from "bun:test";
import {
	formatCronValidationError,
	nextCronOccurrence,
	parseCronExpression,
} from "../../src/core/cron-schedule.js";

describe("parseCronExpression", () => {
	test("parses basic wildcard expressions", () => {
		const parsed = parseCronExpression("0 9 * * 1");
		expect(parsed.expression).toBe("0 9 * * 1");
		expect(parsed.minutes).toEqual([0]);
		expect(parsed.hours).toEqual([9]);
		expect(parsed.dayOfMonth).toBeNull();
		expect(parsed.month).toBeNull();
		expect(parsed.dayOfWeek).toEqual([1]);
	});

	test("supports lists, ranges, and steps", () => {
		const parsed = parseCronExpression("*/15 9-17 * * 1,3,5");
		expect(parsed.minutes).toEqual([0, 15, 30, 45]);
		expect(parsed.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(parsed.dayOfWeek).toEqual([1, 3, 5]);
	});

	test("normalizes sunday 7 to 0", () => {
		const parsed = parseCronExpression("0 8 * * 7");
		expect(parsed.dayOfWeek).toEqual([0]);
	});

	test("rejects malformed expressions", () => {
		expect(() => parseCronExpression("every monday at 9")).toThrow(
			formatCronValidationError("every monday at 9"),
		);
		expect(() => parseCronExpression("0 0 0 * *")).toThrow("day-of-month");
	});
});

describe("nextCronOccurrence", () => {
	test("finds the next matching minute after the reference time", () => {
		const schedule = parseCronExpression("0 9 * * 1");
		const next = nextCronOccurrence(schedule, new Date("2026-04-03T10:15:00Z"));
		expect(next?.toISOString()).toBe("2026-04-06T09:00:00.000Z");
	});

	test("supports same-day future matches", () => {
		const schedule = parseCronExpression("30 14 * * *");
		const next = nextCronOccurrence(schedule, new Date("2026-04-03T14:10:00Z"));
		expect(next?.toISOString()).toBe("2026-04-03T14:30:00.000Z");
	});

	test("requires both day-of-month and day-of-week when both are constrained", () => {
		const schedule = parseCronExpression("0 9 15 * 1");
		const next = nextCronOccurrence(schedule, new Date("2026-04-01T00:00:00Z"));
		expect(next?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
	});
});
