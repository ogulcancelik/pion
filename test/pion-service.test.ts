import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("pion.service", () => {
	test("kills the whole cgroup on stop with a bounded timeout", () => {
		const service = readFileSync("pion.service", "utf-8");

		expect(service).toContain("KillMode=control-group");
		expect(service).toContain("TimeoutStopSec=15");
		expect(service).toContain("SendSIGKILL=yes");
	});
});
