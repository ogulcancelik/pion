#!/usr/bin/env bun
/**
 * Pion Runtime Inspector
 *
 * Hybrid TUI that always loads a persisted session and, when the daemon is
 * running, overlays live runtime state from the inspector socket.
 *
 * Usage:
 *   bun run src/tui/monitor.ts
 *   bun run src/tui/monitor.ts -s
 *   bun run src/tui/monitor.ts [sessionName|/absolute/path.jsonl]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	AssistantMessageComponent,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	Spacer,
	TUI,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { loadConfig } from "../config/loader.js";
import {
	type MonitorTarget,
	listMonitorContextsForAgent,
	resolveDefaultMonitorTarget,
} from "../core/monitor-target.js";
import { expandTilde, homeDir } from "../core/paths.js";
import { RuntimeInspectorClient } from "../core/runtime-inspector-ipc.js";
import type {
	RuntimeInspectorContextSnapshot,
	RuntimeInspectorSnapshot,
} from "../core/runtime-inspector.js";

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
		errorMessage?: string;
	};
}

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

initTheme();
const markdownTheme = getMarkdownTheme();
const THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

function requireTheme(): Theme {
	const theme = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
	if (!theme) {
		throw new Error("Pi theme was not initialized");
	}
	return theme;
}

const theme = requireTheme();

function loadSessionEntries(sessionFile: string): SessionEntry[] {
	if (!existsSync(sessionFile)) return [];

	const content = readFileSync(sessionFile, "utf-8");
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip invalid lines.
		}
	}
	return entries;
}

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

	const sessionHeader = entries.find((entry) => entry.type === "session");
	if (sessionHeader?.cwd) {
		cwd = sessionHeader.cwd;
	}

	for (const entry of entries) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			thinkingLevel = entry.thinkingLevel;
		}
	}

	type MessageUsage = NonNullable<NonNullable<SessionEntry["message"]>["usage"]>;
	let lastAssistantUsage: MessageUsage | undefined;
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

class MessageLog extends Container {
	private entries: SessionEntry[] = [];
	private liveContext?: RuntimeInspectorContextSnapshot;
	private hideThinking = true;
	private expandTools = false;
	private ui: TUI;
	private cwd: string;
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

	setLiveContext(context: RuntimeInspectorContextSnapshot | undefined): void {
		this.liveContext = context;
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
				const assistantMessage = this.buildAssistantMessage(entry.message);
				if (assistantMessage && this.hasVisibleContent(assistantMessage)) {
					const component = new AssistantMessageComponent(
						assistantMessage,
						this.hideThinking,
						markdownTheme,
					);
					this.assistantComponents.push(component);
					this.addChild(component);
				}

				for (const tool of content.filter((item) => item.type === "toolCall")) {
					if (tool.name && tool.id) {
						const toolComponent = new ToolExecutionComponent(
							tool.name,
							tool.id,
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

		if (this.liveContext && this.shouldShowLiveOverlay(this.liveContext)) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.bold(theme.fg("accent", "  Live runtime")), 0, 0));

			if (this.liveContext.pendingMessageCount > 0) {
				this.addChild(
					new Text(
						theme.fg(
							"dim",
							`  buffered: ${this.liveContext.pendingMessageCount} pending message${this.liveContext.pendingMessageCount === 1 ? "" : "s"}`,
						),
						0,
						0,
					),
				);
			}

			if (
				this.liveContext.currentAssistantMessage &&
				this.hasVisibleContent(this.liveContext.currentAssistantMessage)
			) {
				const component = new AssistantMessageComponent(
					this.liveContext.currentAssistantMessage,
					this.hideThinking,
					markdownTheme,
				);
				this.assistantComponents.push(component);
				this.addChild(component);
			}

			for (const tool of this.liveContext.activeTools) {
				const toolComponent = new ToolExecutionComponent(
					tool.toolName,
					tool.toolCallId,
					tool.args,
					{},
					undefined,
					this.ui,
					this.cwd,
				);
				toolComponent.markExecutionStarted();
				toolComponent.setArgsComplete();
				toolComponent.setExpanded(this.expandTools);
				if (tool.partialResult) {
					toolComponent.updateResult(tool.partialResult, true);
				}
				if (tool.result) {
					toolComponent.updateResult(tool.result, false);
				}
				this.toolComponents.push(toolComponent);
				this.addChild(toolComponent);
			}
		}

		this.addChild(new Spacer(4));
	}

	private shouldShowLiveOverlay(context: RuntimeInspectorContextSnapshot): boolean {
		return (
			context.live ||
			context.pendingMessageCount > 0 ||
			context.activeTools.length > 0 ||
			!!context.currentAssistantMessage
		);
	}

	private extractText(content: Array<{ type: string; text?: string }>): string {
		return content
			.filter((item): item is { type: string; text: string } => item.type === "text" && !!item.text)
			.map((item) => item.text)
			.join("\n");
	}

	private buildAssistantMessage(message: SessionEntry["message"]): AssistantMessage | null {
		if (!message) return null;

		const contentItems: AssistantMessage["content"] = [];
		for (const content of message.content) {
			if (content.type === "text" && content.text) {
				contentItems.push({ type: "text", text: content.text });
			} else if (content.type === "thinking" && content.thinking) {
				contentItems.push({
					type: "thinking",
					thinking: content.thinking,
					thinkingSignature: content.thinkingSignature || "",
				});
			}
		}

		return {
			role: "assistant",
			content: contentItems,
			api: message.api || "anthropic-messages",
			provider: message.provider || "anthropic",
			model: message.model || "unknown",
			usage: message.usage || { input: 0, output: 0, totalTokens: 0 },
			stopReason: message.stopReason || "stop",
			timestamp: message.timestamp || Date.now(),
			errorMessage: message.errorMessage,
		} as AssistantMessage;
	}

	private hasVisibleContent(message: AssistantMessage): boolean {
		return message.content.some((content) => {
			if (content.type === "text") return content.text.trim().length > 0;
			if (content.type === "thinking") return (content.thinking || "").trim().length > 0;
			return false;
		});
	}
}

class RuntimeSummaryComponent implements Component {
	private connected = false;
	private context?: RuntimeInspectorContextSnapshot;
	private sessionName = "session";

	setState(
		sessionName: string,
		connected: boolean,
		context: RuntimeInspectorContextSnapshot | undefined,
	): void {
		this.sessionName = sessionName;
		this.connected = connected;
		this.context = context;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (!this.context) {
			const mode = this.connected ? "daemon connected" : "read-only";
			lines.push(truncateToWidth(theme.fg("accent", `  ● ${mode}`), width));
			lines.push(truncateToWidth(theme.fg("dim", `  session: ${this.sessionName}`), width));
			return lines;
		}

		const statusColor =
			this.context.status === "failed"
				? "error"
				: this.context.status === "processing" || this.context.status === "buffered"
					? "accent"
					: this.context.status === "superseded"
						? "warning"
						: "dim";
		const stateLabel = this.context.live ? `${this.context.status} · live` : this.context.status;
		lines.push(
			truncateToWidth(
				theme.fg(statusColor, `  ● ${stateLabel} · ${this.context.agentName ?? "unknown agent"}`),
				width,
			),
		);
		lines.push(truncateToWidth(theme.fg("dim", `  ${this.context.contextKey}`), width));

		const details: string[] = [];
		if (this.context.pendingMessageCount > 0) {
			details.push(`buffered ${this.context.pendingMessageCount}`);
		}
		if (this.context.queue.steering.length > 0) {
			details.push(`steer ${this.context.queue.steering.length}`);
		}
		if (this.context.queue.followUp.length > 0) {
			details.push(`follow-up ${this.context.queue.followUp.length}`);
		}
		if (this.context.activeTools.length > 0) {
			details.push(`tools ${this.context.activeTools.length}`);
		}
		if (details.length === 0 && this.context.lastCompletion) {
			details.push(`last ${this.context.lastCompletion.outcome}`);
		}
		if (details.length > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${details.join(" · ")}`), width));
		}
		if (this.context.lastWarning) {
			lines.push(truncateToWidth(theme.fg("warning", `  ${this.context.lastWarning}`), width));
		}
		return lines;
	}
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

	invalidate(): void {}

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

		const pwdLine = truncateToWidth(
			theme.fg("dim", shortenPath(cwd)),
			width,
			theme.fg("dim", "..."),
		);

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if (totalCost) statsParts.push(`$${totalCost.toFixed(2)}`);

		let contextStr: string;
		if (contextPercent > 90) {
			contextStr = theme.fg("error", `${contextPercent.toFixed(0)}%`);
		} else if (contextPercent > 70) {
			contextStr = theme.fg("warning", `${contextPercent.toFixed(0)}%`);
		} else {
			contextStr = `${contextPercent.toFixed(0)}%`;
		}
		statsParts.push(contextStr);

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

		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length);
		const dimRemainder = theme.fg("dim", remainder);

		const thinkingStatus = this.hideThinking ? "off" : "on";
		const toolsStatus = this.expandTools ? "on" : "off";
		const hints =
			width >= 70
				? `^T thinking: ${thinkingStatus} | ^O tools: ${toolsStatus} | q quit`
				: width >= 50
					? `^T:${thinkingStatus} ^O:${toolsStatus} q:quit`
					: "^T ^O q";

		return [pwdLine, dimStatsLeft + dimRemainder, theme.fg("dim", hints)];
	}
}

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

function getDataDir(): string {
	const config = loadConfig();
	return config.dataDir ? expandTilde(config.dataDir) : join(homeDir(), ".pion");
}

function getSessionTargets(dataDir: string): MonitorTarget[] {
	const sessionsDir = join(dataDir, "sessions");
	if (!existsSync(sessionsDir)) return [];

	return readdirSync(sessionsDir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => ({
			sessionFile: join(sessionsDir, file),
			sessionName: file.replace(/\.jsonl$/, ""),
			source: "session" as const,
		}))
		.sort((a, b) => statSync(b.sessionFile).mtimeMs - statSync(a.sessionFile).mtimeMs);
}

function getSelectListTheme() {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.bold(theme.fg("accent", text)),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("dim", text),
	};
}

async function promptSelect(
	title: string,
	items: SelectItem[],
	hint: string,
): Promise<string | undefined> {
	if (items.length === 0) {
		return undefined;
	}

	return await new Promise<string | undefined>((resolve) => {
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);
		const root = new Container();
		const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());

		const finish = (value: string | undefined) => {
			tui.stop();
			resolve(value);
		};

		list.onSelect = (item) => finish(item.value);
		list.onCancel = () => finish(undefined);

		root.addChild(new Text(theme.bold(theme.fg("accent", `  ${title}`)), 0, 0));
		root.addChild(new Spacer(1));
		root.addChild(list);
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("dim", `  ${hint}`), 0, 0));

		tui.addChild(root);
		tui.setFocus(list);
		tui.start();
	});
}

async function resolveMonitorTarget(dataDir: string): Promise<MonitorTarget> {
	const config = loadConfig();
	const args = process.argv.slice(2);
	const selectFlag = args.includes("-s") || args.includes("--select");
	const explicitTarget = args.find((arg) => !arg.startsWith("-"));

	if (explicitTarget) {
		const sessionFile = explicitTarget.includes("/")
			? explicitTarget
			: join(dataDir, "sessions", `${explicitTarget}.jsonl`);
		return {
			sessionFile,
			sessionName: basename(sessionFile).replace(/\.jsonl$/, ""),
			source: "session",
		};
	}

	if (!selectFlag) {
		return resolveDefaultMonitorTarget(config, dataDir);
	}

	const agentNames = Object.keys(config.agents);
	let agentName: string | undefined;
	if (agentNames.length === 1) {
		agentName = agentNames[0];
	} else {
		const selectedAgent = await promptSelect(
			"Select agent",
			agentNames.map((name) => ({ value: name, label: name })),
			"↑/↓ move · Enter select · Esc cancel",
		);
		if (!selectedAgent) {
			throw new Error("Selection cancelled");
		}
		agentName = selectedAgent;
	}

	const selectedAgentName =
		agentName ??
		(() => {
			throw new Error("No agent selected");
		})();
	const runtimeContexts = listMonitorContextsForAgent(config, dataDir, selectedAgentName);
	const sessionTargets = getSessionTargets(dataDir);
	const contextItems =
		runtimeContexts.length > 0
			? runtimeContexts.map((context) => ({
					value: context.sessionFile,
					label: context.sessionName,
					description: context.live
						? `${context.contextKey} · ${context.status} · live`
						: `${context.contextKey} · ${context.status ?? "idle"}`,
				}))
			: sessionTargets.map((target) => ({
					value: target.sessionFile,
					label: target.sessionName,
					description: "persisted session",
				}));

	const selectedSessionFile = await promptSelect(
		"Select context",
		contextItems,
		"↑/↓ move · Enter select · Esc cancel",
	);
	if (!selectedSessionFile) {
		throw new Error("Selection cancelled");
	}

	const selectedRuntimeContext = runtimeContexts.find(
		(context) => context.sessionFile === selectedSessionFile,
	);
	return {
		agentName: selectedAgentName,
		contextKey: selectedRuntimeContext?.contextKey,
		sessionFile: selectedSessionFile,
		sessionName: basename(selectedSessionFile).replace(/\.jsonl$/, ""),
		source: selectedRuntimeContext ? "runtime" : "session",
	};
}

async function main() {
	const dataDir = getDataDir();
	let target: MonitorTarget;
	try {
		target = await resolveMonitorTarget(dataDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "Selection cancelled") {
			process.exit(0);
		}
		console.log(message);
		process.exit(1);
	}

	let entries = loadSessionEntries(target.sessionFile);
	let stats = computeStats(entries);
	let hideThinking = true;
	let expandTools = false;
	let liveConnected = false;
	let liveContext: RuntimeInspectorContextSnapshot | undefined;
	let liveContextKey = target.contextKey;
	let lastSessionSignature = existsSync(target.sessionFile)
		? `${statSync(target.sessionFile).mtimeMs}:${statSync(target.sessionFile).size}`
		: "missing";

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const header = new Text(theme.bold(theme.fg("accent", `  📋 ${target.sessionName}`)), 0, 0);
	const summary = new RuntimeSummaryComponent();
	const messageLog = new MessageLog(tui, stats.cwd);
	const footer = new FooterComponent();
	footer.setStats(stats);

	messageLog.setEntries(entries);
	messageLog.setLiveContext(undefined);
	summary.setState(target.sessionName, false, undefined);

	const inputHandler = createInputHandler({
		onQuit: () => {
			clearInterval(sessionPoll);
			void liveClient?.close();
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

	tui.addChild(header);
	tui.addChild(new Spacer(1));
	tui.addChild(summary);
	tui.addChild(new Spacer(1));
	tui.addChild(messageLog);
	tui.addChild(footer);
	tui.addChild(inputHandler);
	tui.setFocus(inputHandler);
	tui.start();

	const refreshFromDisk = () => {
		const signature = existsSync(target.sessionFile)
			? `${statSync(target.sessionFile).mtimeMs}:${statSync(target.sessionFile).size}`
			: "missing";
		if (signature === lastSessionSignature) return;
		lastSessionSignature = signature;
		entries = loadSessionEntries(target.sessionFile);
		stats = computeStats(entries);
		footer.setStats(stats);
		messageLog.setEntries(entries);
		tui.requestRender();
	};

	const applySnapshot = (snapshot: RuntimeInspectorSnapshot) => {
		liveConnected = true;
		if (!liveContextKey) {
			liveContextKey = snapshot.contexts.find(
				(context) => context.sessionFile === target.sessionFile,
			)?.contextKey;
		}
		liveContext = liveContextKey
			? snapshot.contexts.find((context) => context.contextKey === liveContextKey)
			: undefined;
		summary.setState(target.sessionName, liveConnected, liveContext);
		messageLog.setLiveContext(liveContext);
		tui.requestRender();
	};

	const sessionPoll = setInterval(refreshFromDisk, 500);
	let liveClient: RuntimeInspectorClient | undefined;
	try {
		liveClient = new RuntimeInspectorClient(dataDir);
		const snapshot = await liveClient.connect();
		applySnapshot(snapshot);
		liveClient.subscribe((nextSnapshot) => applySnapshot(nextSnapshot));
	} catch {
		summary.setState(target.sessionName, false, undefined);
		messageLog.setLiveContext(undefined);
		tui.requestRender();
	}
}

main().catch((error) => {
	console.error("Error:", error instanceof Error ? error.message : error);
	process.exit(1);
});
