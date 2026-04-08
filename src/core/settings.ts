import type { IsolationMode } from "../config/schema.js";
import type { ContextUsageSnapshot } from "./runner.js";

export interface SettingsViewModel {
	status: string;
	agentName: string | null;
	model: string | null | undefined;
	isolation: IsolationMode;
	contextKey: string;
	contextUsage: ContextUsageSnapshot | null;
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatContextUsage(usage: ContextUsageSnapshot | null): string {
	if (!usage || !usage.contextWindow) {
		return "n/a";
	}

	const total = formatTokenCount(usage.contextWindow);
	if (usage.tokens === null || usage.percent === null) {
		return `? / ${total}`;
	}

	return `${formatTokenCount(usage.tokens)} / ${total} (${Math.round(usage.percent)}%)`;
}

export function describeSession(contextKey: string, isolation: IsolationMode): string {
	if (contextKey.includes(":contact:")) {
		return "dm";
	}
	if (contextKey.includes(":chat:")) {
		return "chat";
	}
	return isolation === "per-contact" ? "dm" : "chat";
}

export function buildSettingsText(view: SettingsViewModel): string {
	return [
		"**Runner controls**",
		"",
		`status: ${view.status}`,
		`agent: \`${view.agentName ?? "none"}\``,
		`model: \`${view.model ?? "n/a"}\``,
		`session: \`${describeSession(view.contextKey, view.isolation)}\``,
		`scope: \`${view.isolation}\``,
		`usage: \`${formatContextUsage(view.contextUsage)}\``,
	].join("\n");
}
