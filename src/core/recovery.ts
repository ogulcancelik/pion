import type { ProviderType } from "../providers/types.js";
import type { ActiveContextSnapshot, PersistedDaemonState } from "./runtime-state.js";

export interface RecoveryNotificationTarget {
	provider: ProviderType;
	chatId: string;
	contextKey: string;
}

export function dedupeRecoveryTargets(
	contexts: Array<RecoveryNotificationTarget | ActiveContextSnapshot>,
): RecoveryNotificationTarget[] {
	const seen = new Set<string>();
	const result: RecoveryNotificationTarget[] = [];

	for (const context of contexts) {
		const key = `${context.provider}:${context.chatId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({
			provider: context.provider,
			chatId: context.chatId,
			contextKey: context.contextKey,
		});
	}

	return result;
}

export function buildStartupRecoveryMessage(info: {
	interruptedCount: number;
	lastFatalError?: string;
	lastHeartbeatAt?: string;
}): string {
	const parts = ["⚠️ Pion recovered after an unexpected shutdown."];

	if (info.lastHeartbeatAt) {
		parts.push(`Last heartbeat: ${info.lastHeartbeatAt}`);
	}

	parts.push(`Interrupted chats: ${info.interruptedCount}`);

	if (info.lastFatalError) {
		parts.push(`Last error: ${truncateSingleLine(info.lastFatalError, 200)}`);
	}

	parts.push("Check journalctl --user -u pion for details.");
	return parts.join("\n");
}

export function buildAffectedChatRecoveryMessage(): string {
	return [
		"⚠️ I restarted unexpectedly while processing a message here.",
		"Your session history is intact, but my last reply may have been cut off.",
		"Please resend or continue from where we left off.",
	].join(" ");
}

export function describeRecovery(previousState?: PersistedDaemonState): string | undefined {
	if (!previousState) return undefined;
	return previousState.lastFatalError || previousState.lastHeartbeatAt || previousState.startedAt;
}

function truncateSingleLine(value: string, maxLength: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (line.length <= maxLength) return line;
	return `${line.slice(0, maxLength - 1)}…`;
}
