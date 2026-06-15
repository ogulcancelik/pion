/**
 * Runtime agent profiles — the unifying primitive behind saved sub-agents.
 *
 * A profile is a named, persisted agent configuration (model/provider plus
 * optional tools, instructions, thinking level, skills) that the user can
 * create by talking to pion at runtime. Profiles are consumed two ways:
 *   - cron jobs run a profile on a schedule and deliver the result back, and
 *   - the `subagent` tool delegates to a profile inline.
 *
 * File-backed and no DB, consistent with the rest of pion: the JSON file is the
 * source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "../config/schema.js";

export interface AgentProfile {
	name: string;
	/** Model as a "provider/id" string, e.g. "google/gemini-2.5-pro". */
	model: string;
	/** Optional comma-separated tool list for the subagent/peer path. */
	tools?: string;
	/** Optional inline system prompt / instructions for the profile. */
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	skills?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface SaveAgentProfileInput {
	name: string;
	model: string;
	tools?: string;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	skills?: string[];
}

/** A model string is valid when it is "provider/id" with both sides non-empty. */
function isValidModel(model: string): boolean {
	const slashIndex = model.indexOf("/");
	return slashIndex > 0 && slashIndex < model.length - 1;
}

export class AgentProfileStore {
	constructor(private readonly filePath: string) {}

	list(): AgentProfile[] {
		return Object.values(this.load()).sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): AgentProfile | undefined {
		return this.load()[name.trim()];
	}

	save(input: SaveAgentProfileInput): AgentProfile {
		const name = input.name.trim();
		if (name.length === 0) {
			throw new Error("Agent profile name must not be empty.");
		}
		if (!isValidModel(input.model)) {
			throw new Error(`Agent profile model must be "provider/id", got: ${input.model}`);
		}

		const profiles = this.load();
		const now = new Date().toISOString();
		const existing = profiles[name];

		const profile: AgentProfile = {
			name,
			model: input.model,
			tools: input.tools,
			systemPrompt: input.systemPrompt,
			thinkingLevel: input.thinkingLevel,
			skills: input.skills,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		profiles[name] = profile;
		this.persist(profiles);
		return profile;
	}

	delete(name: string): boolean {
		const profiles = this.load();
		if (!(name.trim() in profiles)) {
			return false;
		}
		delete profiles[name.trim()];
		this.persist(profiles);
		return true;
	}

	private load(): Record<string, AgentProfile> {
		if (!existsSync(this.filePath)) {
			return {};
		}
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {};
			}
			return parsed as Record<string, AgentProfile>;
		} catch {
			return {};
		}
	}

	private persist(profiles: Record<string, AgentProfile>): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(profiles, null, 2)}\n`, "utf-8");
	}
}
