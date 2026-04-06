import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { RuntimeInspectorStore } from "./runtime-inspector.js";

export interface MonitorTarget {
	agentName?: string;
	contextKey?: string;
	sessionFile: string;
	sessionName: string;
	source: "runtime" | "session";
}

export interface MonitorContextChoice {
	agentName?: string;
	contextKey?: string;
	sessionFile: string;
	sessionName: string;
	status?: string;
	lastActiveAt?: string;
	live?: boolean;
}

function defaultAgentName(config: Config): string | undefined {
	if (config.agents.main) return "main";
	const agentNames = Object.keys(config.agents);
	if (agentNames.length === 1) {
		return agentNames[0];
	}
	return undefined;
}

function findMostRecentSessionFile(dataDir: string): string | undefined {
	const sessionsDir = join(dataDir, "sessions");
	if (!existsSync(sessionsDir)) return undefined;

	return readdirSync(sessionsDir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => ({
			file: join(sessionsDir, file),
			mtime: statSync(join(sessionsDir, file)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

function sessionNameForFile(sessionFile: string): string {
	return (
		sessionFile
			.split("/")
			.pop()
			?.replace(/\.jsonl$/, "") ?? "session"
	);
}

export function listMonitorContextsForAgent(
	config: Config,
	dataDir: string,
	agentName: string,
): MonitorContextChoice[] {
	if (!config.agents[agentName]) {
		return [];
	}

	return new RuntimeInspectorStore(dataDir)
		.getSnapshot()
		.contexts.filter((entry) => entry.agentName === agentName)
		.map((entry) => ({
			agentName,
			contextKey: entry.contextKey,
			sessionFile: entry.sessionFile,
			sessionName: entry.sessionName,
			status: entry.status,
			lastActiveAt: entry.lastActiveAt,
			live: entry.live,
		}))
		.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
}

export function resolveDefaultMonitorTarget(config: Config, dataDir: string): MonitorTarget {
	const agentName = defaultAgentName(config);
	const contexts = agentName ? listMonitorContextsForAgent(config, dataDir, agentName) : [];

	if (contexts.length > 0) {
		const context = contexts[0];
		if (context) {
			return {
				agentName,
				contextKey: context.contextKey,
				sessionFile: context.sessionFile,
				sessionName: context.sessionName,
				source: "runtime",
			};
		}
	}

	const sessionFile = findMostRecentSessionFile(dataDir);
	if (!sessionFile) {
		throw new Error(`No sessions found in ${join(dataDir, "sessions")}`);
	}

	return {
		agentName,
		sessionFile,
		sessionName: sessionNameForFile(sessionFile),
		source: "session",
	};
}
