#!/usr/bin/env bun
/**
 * Pion Session Monitor
 *
 * Read-only TUI that watches a session and displays messages in real-time.
 * Uses pi-coding-agent components for consistent look with pi CLI.
 *
 * Usage:
 *   bun run src/tui/monitor.ts [sessionName]
 *
 * Keys:
 *   Ctrl+T - Toggle thinking blocks visibility
 *   Ctrl+O - Toggle tool output expansion
 *   q/Ctrl+C - Exit
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { homeDir } from "../core/paths.js";
import {
	type Theme,
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface SessionEntry {
	type: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	message?: {
		role: string;
		content: Array<{
			type: string;
			text?: string;
			thinking?: string;
			thinkingSignature?: string;
			name?: string;
			id?: string;
			arguments?: unknown;
		}>;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		api?: string;
		provider?: string;
		model?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
		stopReason?: string;
		timestamp?: number;
	};
}

// ============================================================================
// Theme Setup
// ============================================================================

// Initialize pi theme (sets up global theme for components)
initTheme();
const markdownTheme = getMarkdownTheme();

// Access the global theme instance for styling our own components
const THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");
const theme: Theme = (globalThis as Record<symbol, Theme>)[THEME_KEY];

// ============================================================================
// Session File Handling
// ============================================================================

function getDataDir(): string {
	return join(homeDir(), ".pion");
}

function findMostRecentSession(dataDir: string): string | null {
	const sessionsDir = join(dataDir, "sessions");
	if (!existsSync(sessionsDir)) return null;

	const files = readdirSync(sessionsDir)
		.filter((f) => f.endsWith(".jsonl") && !f.includes(".empty") && !f.includes("archive"))
		.map((f) => ({
			name: f,
			path: join(sessionsDir, f),
			mtime: statSync(join(sessionsDir, f)).mtime,
		}))
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	return files[0]?.path ?? null;
}

function loadSessionEntries(sessionFile: string): SessionEntry[] {
	if (!existsSync(sessionFile)) return [];

	const content = readFileSync(sessionFile, "utf-8");
	const entries: SessionEntry[] = [];

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip invalid lines
		}
	}

	return entries;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function shortenPath(path: string): string {
	const home = homeDir();
	if (home && path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

// ============================================================================
// Message Display
// ============================================================================

class MessageLog extends Container {
	private entries: SessionEntry[] = [];
	private hideThinking = true;
	private expandTools = false;
	private ui: TUI;
	private cwd: string;

	// Track components for state updates
	private assistantComponents: AssistantMessageComponent[] = [];
	private toolComponents: ToolExecutionComponent[] = [];

	constructor(ui: TUI, cwd: string) {
		super();
		this.ui = ui;
		this.cwd = cwd;
	}

	setEntries(entries: SessionEntry[]): void {
		this.entries = entries;
		this.rebuildContent();
	}

	setHideThinking(hide: boolean): void {
		this.hideThinking = hide;
		for (const component of this.assistantComponents) {
			component.setHideThinkingBlock(hide);
			component.invalidate();
		}
	}

	setExpandTools(expand: boolean): void {
		this.expandTools = expand;
		for (const component of this.toolComponents) {
			component.setExpanded(expand);
		}
	}

	private rebuildContent(): void {
		this.clear();
		this.assistantComponents = [];
		this.toolComponents = [];

		// Build a map of toolCallId -> toolResult for matching
		const toolResults = new Map<
			string,
			{
				content: Array<{ type: string; text?: string }>;
				isError: boolean;
				details?: unknown;
			}
		>();

		for (const entry of this.entries) {
			if (
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				entry.message.toolCallId
			) {
				toolResults.set(entry.message.toolCallId, {
					content: entry.message.content as Array<{ type: string; text?: string }>,
					isError: entry.message.isError || false,
					details: entry.message.details,
				});
			}
		}

		for (const entry of this.entries) {
			if (entry.type !== "message" || !entry.message) continue;

			const { role, content } = entry.message;

			if (role === "user") {
				const text = this.extractText(content);
				const cleanText = text.replace(/^\[[\d\-T:.Z]+\s*\|\s*Context:\s*\d+%\]\s*/m, "").trim();
				if (cleanText) {
					this.addChild(new UserMessageComponent(cleanText, markdownTheme));
				}
			} else if (role === "assistant") {
				// Text/thinking first (matches pi's visual order)
				const assistantMsg = this.buildAssistantMessage(entry.message);
				if (assistantMsg && this.hasVisibleContent(assistantMsg)) {
					const component = new AssistantMessageComponent(
						assistantMsg,
						this.hideThinking,
						markdownTheme,
					);
					this.assistantComponents.push(component);
					this.addChild(component);
				}

				// Then tool calls with results
				const toolCalls = content.filter((c) => c.type === "toolCall");
				for (const tool of toolCalls) {
					if (tool.name && tool.id) {
						const toolComponent = new ToolExecutionComponent(
							tool.name,
							tool.arguments,
							{},
							undefined,
							this.ui,
							this.cwd,
						);

						toolComponent.setExpanded(this.expandTools);

						const result = toolResults.get(tool.id);
						if (result) {
							toolComponent.updateResult(
								{
									content: result.content,
									isError: result.isError,
									details: result.details,
								},
								false,
							);
						}

						this.toolComponents.push(toolComponent);
						this.addChild(toolComponent);
					}
				}
			}
		}

		// Bottom spacer for footer clearance
		this.addChild(new Spacer(4));
	}

	private extractText(content: Array<{ type: string; text?: string }>): string {
		return content
			.filter((c): c is { type: string; text: string } => c.type === "text" && !!c.text)
			.map((c) => c.text)
			.join("\n");
	}

	private buildAssistantMessage(msg: SessionEntry["message"]): AssistantMessage | null {
		if (!msg) return null;

		const contentItems: AssistantMessage["content"] = [];
		for (const c of msg.content) {
			if (c.type === "text" && c.text) {
				contentItems.push({ type: "text", text: c.text });
			} else if (c.type === "thinking" && c.thinking) {
				contentItems.push({
					type: "thinking",
					thinking: c.thinking,
					thinkingSignature: c.thinkingSignature || "",
				});
			}
		}

		return {
			role: "assistant",
			content: contentItems,
			api: msg.api || "anthropic-messages",
			provider: msg.provider || "anthropic",
			model: msg.model || "unknown",
			usage: msg.usage || { input: 0, output: 0, totalTokens: 0 },
			stopReason: msg.stopReason || "stop",
			timestamp: msg.timestamp || Date.now(),
		} as AssistantMessage;
	}

	private hasVisibleContent(msg: AssistantMessage): boolean {
		return msg.content.some((c) => {
			if (c.type === "text") return c.text.trim().length > 0;
			if (c.type === "thinking") return (c.thinking || "").trim().length > 0;
			return false;
		});
	}
}

// ============================================================================
// Footer Component — implements Component properly, uses pi theme
// ============================================================================

interface SessionStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	contextTokens: number;
	contextPercent: number;
	model: string;
	thinkingLevel: string;
	cwd: string;
}

class FooterComponent implements Component {
	private stats: SessionStats = {
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		contextTokens: 0,
		contextPercent: 0,
		model: "unknown",
		thinkingLevel: "",
		cwd: process.cwd(),
	};
	private hideThinking = true;
	private expandTools = false;

	invalidate(): void {
		// No cached state to clear — render() reads from this.stats directly
	}

	setStats(stats: SessionStats): void {
		this.stats = stats;
	}

	setHideThinking(hide: boolean): void {
		this.hideThinking = hide;
	}

	setExpandTools(expand: boolean): void {
		this.expandTools = expand;
	}

	render(width: number): string[] {
		const {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			contextPercent,
			model,
			thinkingLevel,
			cwd,
		} = this.stats;

		// Line 1: Path
		const pwdLine = truncateToWidth(theme.fg("dim", shortenPath(cwd)), width, theme.fg("dim", "..."));

		// Line 2: Stats and model
		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if (totalCost) statsParts.push(`$${totalCost.toFixed(2)}`);

		// Context percentage with color coding
		let contextStr: string;
		if (contextPercent > 90) {
			contextStr = theme.fg("error", `${contextPercent.toFixed(0)}%`);
		} else if (contextPercent > 70) {
			contextStr = theme.fg("warning", `${contextPercent.toFixed(0)}%`);
		} else {
			contextStr = `${contextPercent.toFixed(0)}%`;
		}
		statsParts.push(contextStr);

		// Right side: model + thinking level
		let rightSide = model;
		if (thinkingLevel && thinkingLevel !== "off") {
			rightSide = `${model} • ${thinkingLevel}`;
		}

		const statsLeft = statsParts.join(" ");
		const statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = truncateToWidth(statsLeft, width, "...");
			}
		}

		// Dim the stats line, preserving color codes in statsLeft (context %)
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length);
		const dimRemainder = theme.fg("dim", remainder);

		// Line 3: Keybinding hints
		const thinkingStatus = this.hideThinking ? "off" : "on";
		const toolsStatus = this.expandTools ? "on" : "off";

		let hints: string;
		if (width >= 70) {
			hints = `^T thinking: ${thinkingStatus} | ^O tools: ${toolsStatus} | q quit`;
		} else if (width >= 50) {
			hints = `^T:${thinkingStatus} ^O:${toolsStatus} q:quit`;
		} else {
			hints = "^T ^O q";
		}

		return [pwdLine, dimStatsLeft + dimRemainder, theme.fg("dim", hints)];
	}
}

// ============================================================================
// Input Handler — implements Component interface
// ============================================================================

function createInputHandler(callbacks: {
	onQuit: () => void;
	onToggleThinking: () => void;
	onToggleTools: () => void;
}): Component {
	return {
		render: () => [],
		invalidate: () => {},
		handleInput: (data: string) => {
			if (data === "q" || matchesKey(data, "ctrl+c")) {
				callbacks.onQuit();
			} else if (matchesKey(data, "ctrl+t")) {
				callbacks.onToggleThinking();
			} else if (matchesKey(data, "ctrl+o")) {
				callbacks.onToggleTools();
			}
		},
	};
}

// ============================================================================
// Compute Stats from Entries
// ============================================================================

function computeStats(entries: SessionEntry[]): SessionStats {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let contextTokens = 0;
	let model = "unknown";
	let thinkingLevel = "";
	let cwd = process.cwd();

	const sessionHeader = entries.find((e) => e.type === "session");
	if (sessionHeader?.cwd) {
		cwd = sessionHeader.cwd;
	}

	for (const entry of entries) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			thinkingLevel = entry.thinkingLevel;
		}
	}

	let lastAssistantUsage: SessionEntry["message"]["usage"] | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			const usage = entry.message.usage;
			totalInput += usage.input || 0;
			totalOutput += usage.output || 0;
			totalCacheRead += usage.cacheRead || 0;
			totalCacheWrite += usage.cacheWrite || 0;
			totalCost += usage.cost?.total || 0;
			lastAssistantUsage = usage;

			if (entry.message.model) {
				model = entry.message.model;
			}
		}
	}

	if (lastAssistantUsage) {
		contextTokens =
			(lastAssistantUsage.input || 0) +
			(lastAssistantUsage.output || 0) +
			(lastAssistantUsage.cacheRead || 0) +
			(lastAssistantUsage.cacheWrite || 0);
	}

	const contextWindow = 200000;
	const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

	return {
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		contextTokens,
		contextPercent,
		model,
		thinkingLevel,
		cwd,
	};
}

// ============================================================================
// Main TUI
// ============================================================================

async function main() {
	const dataDir = getDataDir();
	const sessionsDir = join(dataDir, "sessions");

	// Determine session file
	let sessionFile: string | null = null;
	const arg = process.argv[2];

	if (!arg) {
		sessionFile = findMostRecentSession(dataDir);
		if (!sessionFile) {
			console.log("No sessions found in", sessionsDir);
			process.exit(1);
		}
	} else if (!arg.includes("/")) {
		sessionFile = join(sessionsDir, `${arg}.jsonl`);
	} else {
		sessionFile = arg;
	}

	if (!existsSync(sessionFile)) {
		console.log(`Session file not found: ${sessionFile}`);
		process.exit(1);
	}

	const sessionName = sessionFile.split("/").pop()?.replace(".jsonl", "") || "session";

	// Load initial entries
	let entries = loadSessionEntries(sessionFile);
	let stats = computeStats(entries);

	// Create TUI
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// State
	let hideThinking = true;
	let expandTools = false;

	// Create components
	const header = new Text(theme.bold(theme.fg("accent", `  📋 ${sessionName}`)), 0, 0);
	const messageLog = new MessageLog(tui, stats.cwd);
	const footer = new FooterComponent();

	footer.setStats(stats);

	tui.addChild(header);
	tui.addChild(new Spacer(1));
	tui.addChild(messageLog);
	tui.addChild(footer);

	// Load initial entries
	messageLog.setEntries(entries);

	// Watch for changes
	const file = sessionFile;
	let lastEntryCount = entries.length;

	const watcher = watch(file, (eventType) => {
		if (eventType === "change") {
			const newEntries = loadSessionEntries(file);
			if (newEntries.length !== lastEntryCount) {
				entries = newEntries;
				lastEntryCount = entries.length;
				stats = computeStats(entries);
				footer.setStats(stats);
				messageLog.setEntries(entries);
				tui.requestRender();
			}
		}
	});

	// Input handler
	const inputHandler = createInputHandler({
		onQuit: () => {
			watcher.close();
			tui.stop();
			process.exit(0);
		},
		onToggleThinking: () => {
			hideThinking = !hideThinking;
			messageLog.setHideThinking(hideThinking);
			footer.setHideThinking(hideThinking);
			tui.requestRender();
		},
		onToggleTools: () => {
			expandTools = !expandTools;
			messageLog.setExpandTools(expandTools);
			footer.setExpandTools(expandTools);
			tui.requestRender();
		},
	});

	tui.addChild(inputHandler);
	tui.setFocus(inputHandler);

	tui.start();
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
