/**
 * Convert markdown to Telegram HTML.
 * Based on clawdbot's approach.
 *
 * Telegram supports: <b>, <i>, <s>, <code>, <pre>, <a href="">
 */

import MarkdownIt from "markdown-it";

type ListState = {
	type: "bullet" | "ordered";
	index: number;
};

type RenderEnv = {
	telegramListStack?: ListState[];
	telegramLinkStack?: boolean[];
};

const md = new MarkdownIt({
	html: false,
	linkify: false,
	breaks: false,
	typographer: false,
});

md.enable("strikethrough");

const { escapeHtml } = md.utils;

function getListStack(env: RenderEnv): ListState[] {
	if (!env.telegramListStack) env.telegramListStack = [];
	return env.telegramListStack;
}

function getLinkStack(env: RenderEnv): boolean[] {
	if (!env.telegramLinkStack) env.telegramLinkStack = [];
	return env.telegramLinkStack;
}

// Text and breaks
md.renderer.rules.text = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.softbreak = () => "\n";
md.renderer.rules.hardbreak = () => "\n";

// Paragraphs
md.renderer.rules.paragraph_open = () => "";
md.renderer.rules.paragraph_close = (_tokens, _idx, _opts, env) => {
	const stack = getListStack(env as RenderEnv);
	return stack.length ? "" : "\n\n";
};

// Headings (just bold, no special rendering)
md.renderer.rules.heading_open = () => "<b>";
md.renderer.rules.heading_close = () => "</b>\n\n";

// Blockquotes
md.renderer.rules.blockquote_open = () => "";
md.renderer.rules.blockquote_close = () => "\n";

// Lists
md.renderer.rules.bullet_list_open = (_tokens, _idx, _opts, env) => {
	getListStack(env as RenderEnv).push({ type: "bullet", index: 0 });
	return "";
};
md.renderer.rules.bullet_list_close = (_tokens, _idx, _opts, env) => {
	getListStack(env as RenderEnv).pop();
	return "";
};
md.renderer.rules.ordered_list_open = (tokens, idx, _opts, env) => {
	const start = Number(tokens[idx]?.attrGet("start") ?? "1");
	getListStack(env as RenderEnv).push({ type: "ordered", index: start - 1 });
	return "";
};
md.renderer.rules.ordered_list_close = (_tokens, _idx, _opts, env) => {
	getListStack(env as RenderEnv).pop();
	return "";
};
md.renderer.rules.list_item_open = (_tokens, _idx, _opts, env) => {
	const stack = getListStack(env as RenderEnv);
	const top = stack[stack.length - 1];
	if (!top) return "";
	top.index += 1;
	const indent = "  ".repeat(Math.max(0, stack.length - 1));
	const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
	return `${indent}${prefix}`;
};
md.renderer.rules.list_item_close = () => "\n";

// Inline formatting
md.renderer.rules.em_open = () => "<i>";
md.renderer.rules.em_close = () => "</i>";
md.renderer.rules.strong_open = () => "<b>";
md.renderer.rules.strong_close = () => "</b>";
md.renderer.rules.s_open = () => "<s>";
md.renderer.rules.s_close = () => "</s>";

// Code
md.renderer.rules.code_inline = (tokens, idx) =>
	`<code>${escapeHtml(tokens[idx]?.content ?? "")}</code>`;
md.renderer.rules.code_block = (tokens, idx) =>
	`<pre><code>${escapeHtml(tokens[idx]?.content ?? "")}</code></pre>\n`;
md.renderer.rules.fence = (tokens, idx) =>
	`<pre><code>${escapeHtml(tokens[idx]?.content ?? "")}</code></pre>\n`;

// Links
md.renderer.rules.link_open = (tokens, idx, _opts, env) => {
	const href = tokens[idx]?.attrGet("href") ?? "";
	const safeHref = escapeHtml(href);
	const stack = getLinkStack(env as RenderEnv);
	const hasHref = Boolean(safeHref);
	stack.push(hasHref);
	return hasHref ? `<a href="${safeHref}">` : "";
};
md.renderer.rules.link_close = (_tokens, _idx, _opts, env) => {
	const stack = getLinkStack(env as RenderEnv);
	const hasHref = stack.pop();
	return hasHref ? "</a>" : "";
};

// Images (just show alt text)
md.renderer.rules.image = (tokens, idx) => {
	const alt = tokens[idx]?.content ?? "";
	return escapeHtml(alt);
};

// HTML (escape it)
md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");

// Tables (simple tab-separated)
md.renderer.rules.table_open = () => "";
md.renderer.rules.table_close = () => "";
md.renderer.rules.thead_open = () => "";
md.renderer.rules.thead_close = () => "";
md.renderer.rules.tbody_open = () => "";
md.renderer.rules.tbody_close = () => "";
md.renderer.rules.tr_open = () => "";
md.renderer.rules.tr_close = () => "\n";
md.renderer.rules.th_open = () => "";
md.renderer.rules.th_close = () => "\t";
md.renderer.rules.td_open = () => "";
md.renderer.rules.td_close = () => "\t";

// Horizontal rule
md.renderer.rules.hr = () => "\n";

/**
 * Convert markdown to Telegram-compatible HTML.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const env: RenderEnv = {};
	const rendered = md.render(markdown ?? "", env);
	return rendered
		.replace(/[ \t]+\n/g, "\n") // trailing whitespace
		.replace(/\t+\n/g, "\n") // trailing tabs
		.replace(/\n{3,}/g, "\n\n") // max 2 newlines
		.trimEnd();
}
