import { describe, expect, test } from "bun:test";
import { getOutputDeliveryTarget } from "../../src/core/output-routing.js";

describe("getOutputDeliveryTarget", () => {
	test("does not auto-reply for streamed assistant output", () => {
		expect(getOutputDeliveryTarget("stream", "msg-1")).toEqual({});
	});

	test("does not auto-reply for fallback, warnings, or errors", () => {
		expect(getOutputDeliveryTarget("fallback", "msg-1")).toEqual({});
		expect(getOutputDeliveryTarget("warning", "msg-1")).toEqual({});
		expect(getOutputDeliveryTarget("error", "msg-1")).toEqual({});
	});
});
