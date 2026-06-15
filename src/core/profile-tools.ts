/**
 * Agent-facing tools for managing runtime agent profiles (saved sub-agents).
 *
 * `save_subagent` lets the user create a named profile by talking to pion
 * ("save a `simulation` agent that uses Gemini"); `list_subagents` shows what
 * exists. Profiles are then usable by the `subagent` tool (inline delegation)
 * and by cron jobs (scheduled runs). Backed by [[AgentProfileStore]].
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentProfileStore } from "./agent-profiles.js";

const saveSubagentSchema = Type.Object({
	name: Type.String({
		description: "Short profile name to save under, e.g. 'simulation' or 'researcher'.",
	}),
	model: Type.String({
		description: 'Model as "provider/id", e.g. "google/gemini-2.5-pro" or "minimax/minimax-m2".',
	}),
	tools: Type.Optional(
		Type.String({
			description:
				"Optional comma-separated tools to grant this profile when used (default read-only).",
		}),
	),
	instructions: Type.Optional(
		Type.String({ description: "Optional system instructions for this profile." }),
	),
});

const listSubagentsSchema = Type.Object({});

type SaveSubagentParams = Static<typeof saveSubagentSchema>;

interface ProfileToolDetails {
	error?: boolean;
	name?: string;
}

export function createProfileTools(store: AgentProfileStore): ToolDefinition[] {
	const saveSubagentTool: ToolDefinition<typeof saveSubagentSchema, ProfileToolDetails> = {
		name: "save_subagent",
		label: "Save Subagent",
		description:
			"Save a named agent profile (a model/provider plus optional tools and instructions) for reuse. Once saved, the profile can be used by the subagent tool or scheduled with a cron job. Use when the user asks to set up or remember a specific sub-agent.",
		promptSnippet:
			"save_subagent(name, model, tools?, instructions?) - persist a reusable named agent profile",
		parameters: saveSubagentSchema,
		async execute(
			_toolCallId: string,
			params: SaveSubagentParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<ProfileToolDetails> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<ProfileToolDetails>> {
			try {
				const profile = store.save({
					name: params.name,
					model: params.model,
					tools: params.tools,
					systemPrompt: params.instructions,
				});
				return {
					content: [
						{
							type: "text",
							text: `Saved subagent "${profile.name}" → ${profile.model}${profile.tools ? ` (tools: ${profile.tools})` : ""}.`,
						},
					],
					details: { name: profile.name },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Could not save subagent: ${message}` }],
					details: { error: true },
				};
			}
		},
	};

	const listSubagentsTool: ToolDefinition<typeof listSubagentsSchema, ProfileToolDetails> = {
		name: "list_subagents",
		label: "List Subagents",
		description: "List saved agent profiles (name, model, tools) available to the subagent tool.",
		promptSnippet: "list_subagents() - list saved agent profiles",
		parameters: listSubagentsSchema,
		async execute(): Promise<AgentToolResult<ProfileToolDetails>> {
			const profiles = store.list();
			if (profiles.length === 0) {
				return {
					content: [{ type: "text", text: "No saved subagents yet." }],
					details: {},
				};
			}
			const body = profiles
				.map((p) => `- ${p.name} → ${p.model}${p.tools ? ` (tools: ${p.tools})` : ""}`)
				.join("\n");
			return {
				content: [{ type: "text", text: `Saved subagents:\n${body}` }],
				details: {},
			};
		},
	};

	return [
		saveSubagentTool as unknown as ToolDefinition,
		listSubagentsTool as unknown as ToolDefinition,
	];
}
