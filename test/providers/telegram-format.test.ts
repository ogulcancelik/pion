import { describe, expect, test } from "bun:test";
import { markdownToTelegramHtml } from "../../src/providers/telegram-format.js";

describe("markdownToTelegramHtml", () => {
	test("converts bold", () => {
		expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
	});

	test("converts italic", () => {
		expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
	});

	test("converts inline code", () => {
		expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
	});

	test("converts code blocks", () => {
		const input = "```\nconst x = 1;\n```";
		const output = markdownToTelegramHtml(input);
		expect(output).toContain("<pre><code>");
		expect(output).toContain("const x = 1;");
		expect(output).toContain("</code></pre>");
	});

	test("converts links", () => {
		expect(markdownToTelegramHtml("[link](https://example.com)")).toBe(
			'<a href="https://example.com">link</a>',
		);
	});

	test("converts bullet lists", () => {
		const input = "- one\n- two";
		const output = markdownToTelegramHtml(input);
		expect(output).toContain("• one");
		expect(output).toContain("• two");
	});

	test("converts ordered lists", () => {
		const input = "1. one\n2. two";
		const output = markdownToTelegramHtml(input);
		expect(output).toContain("1. one");
		expect(output).toContain("2. two");
	});

	test("escapes HTML in text", () => {
		expect(markdownToTelegramHtml("<script>alert(1)</script>")).toBe(
			"&lt;script&gt;alert(1)&lt;/script&gt;",
		);
	});

	test("converts headings to bold", () => {
		expect(markdownToTelegramHtml("# Heading")).toContain("<b>Heading</b>");
	});

	test("handles mixed content", () => {
		const input = "Hello **world**!\n\nThis is `code`.";
		const output = markdownToTelegramHtml(input);
		expect(output).toContain("<b>world</b>");
		expect(output).toContain("<code>code</code>");
	});
});
