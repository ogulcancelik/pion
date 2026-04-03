export interface ParsedCronSchedule {
	expression: string;
	minutes: number[] | null;
	hours: number[] | null;
	dayOfMonth: number[] | null;
	month: number[] | null;
	dayOfWeek: number[] | null;
}

const FIELD_RANGES = {
	minute: { min: 0, max: 59 },
	hour: { min: 0, max: 23 },
	dayOfMonth: { min: 1, max: 31 },
	month: { min: 1, max: 12 },
	dayOfWeek: { min: 0, max: 7 },
} as const;

export function formatCronValidationError(expression: string): string {
	return `Schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week). Received: ${expression}`;
}

export function parseCronExpression(expression: string): ParsedCronSchedule {
	const normalized = expression.trim().replace(/\s+/g, " ");
	const parts = normalized.split(" ");
	if (parts.length !== 5) {
		throw new Error(formatCronValidationError(expression));
	}

	return {
		expression: normalized,
		minutes: parseCronField(parts[0] ?? "", FIELD_RANGES.minute, "minute"),
		hours: parseCronField(parts[1] ?? "", FIELD_RANGES.hour, "hour"),
		dayOfMonth: parseCronField(parts[2] ?? "", FIELD_RANGES.dayOfMonth, "day-of-month"),
		month: parseCronField(parts[3] ?? "", FIELD_RANGES.month, "month"),
		dayOfWeek: normalizeDayOfWeek(
			parseCronField(parts[4] ?? "", FIELD_RANGES.dayOfWeek, "day-of-week"),
		),
	};
}

export function nextCronOccurrence(
	schedule: ParsedCronSchedule,
	after: Date,
	maxLookaheadMinutes = 366 * 24 * 60,
): Date | null {
	const cursor = new Date(after.getTime());
	cursor.setUTCSeconds(0, 0);
	cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

	for (let i = 0; i < maxLookaheadMinutes; i++) {
		if (matchesSchedule(schedule, cursor)) {
			return new Date(cursor.getTime());
		}
		cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
	}

	return null;
}

function matchesSchedule(schedule: ParsedCronSchedule, date: Date): boolean {
	if (!matchesField(schedule.month, date.getUTCMonth() + 1)) return false;
	if (!matchesField(schedule.hours, date.getUTCHours())) return false;
	if (!matchesField(schedule.minutes, date.getUTCMinutes())) return false;

	const domMatches = matchesField(schedule.dayOfMonth, date.getUTCDate());
	const dowMatches = matchesField(schedule.dayOfWeek, date.getUTCDay());

	if (schedule.dayOfMonth && schedule.dayOfWeek) {
		return domMatches && dowMatches;
	}
	if (schedule.dayOfMonth) return domMatches;
	if (schedule.dayOfWeek) return dowMatches;
	return true;
}

function matchesField(values: number[] | null, candidate: number): boolean {
	return values === null || values.includes(candidate);
}

function normalizeDayOfWeek(values: number[] | null): number[] | null {
	if (values === null) return null;
	return [...new Set(values.map((value) => (value === 7 ? 0 : value)).sort((a, b) => a - b))];
}

function parseCronField(
	field: string,
	range: { min: number; max: number },
	label: string,
): number[] | null {
	if (field === "*") {
		return null;
	}

	const values = new Set<number>();
	for (const token of field.split(",")) {
		if (!token) {
			throw new Error(`Invalid ${label} field: ${field}`);
		}
		for (const value of expandCronToken(token, range, label)) {
			values.add(value);
		}
	}

	if (values.size === 0) {
		throw new Error(`Invalid ${label} field: ${field}`);
	}

	return [...values].sort((a, b) => a - b);
}

function expandCronToken(
	token: string,
	range: { min: number; max: number },
	label: string,
): number[] {
	const [base = "", stepPart] = token.split("/");
	const step = stepPart === undefined ? 1 : parsePositiveInt(stepPart, `${label} step`);
	if (step <= 0) {
		throw new Error(`Invalid ${label} field: ${token}`);
	}

	const [start, end] = parseCronBase(base, range, label);
	const values: number[] = [];
	for (let value = start; value <= end; value += step) {
		values.push(assertInRange(value, range, label));
	}
	return values;
}

function parseCronBase(
	base: string,
	range: { min: number; max: number },
	label: string,
): [number, number] {
	if (base === "*" || base === "") {
		return [range.min, range.max];
	}
	if (base.includes("-")) {
		const [startText, endText] = base.split("-");
		const start = assertInRange(parsePositiveInt(startText ?? "", label), range, label);
		const end = assertInRange(parsePositiveInt(endText ?? "", label), range, label);
		if (end < start) {
			throw new Error(`Invalid ${label} field: ${base}`);
		}
		return [start, end];
	}
	const value = assertInRange(parsePositiveInt(base, label), range, label);
	return [value, value];
}

function parsePositiveInt(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new Error(`Invalid ${label} field: ${raw}`);
	}
	return Number.parseInt(raw, 10);
}

function assertInRange(value: number, range: { min: number; max: number }, label: string): number {
	if (value < range.min || value > range.max) {
		throw new Error(`Invalid ${label} field: value ${value} is out of range`);
	}
	return value;
}
