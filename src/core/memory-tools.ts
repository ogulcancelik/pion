/**
 * Native memory tool — agent-decided note taking.
 *
 * The agent calls `remember` when something is worth keeping long-term.
 * Notes append to a dated journal file under `<workspace>/memory/daily/`,
 * one file per local day. The daily folder is loaded back into future system
 * prompts by `loadDailyNotes` in workspace.ts, so a note taken today flows into
 * later sessions automatically.
 *
 * File-native and no DB: the markdown files are the source of truth.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { expandTilde } from "./paths.js";

const rememberSchema = Type.Object({
	note: Type.String({
		description:
			"A single concise fact worth remembering long-term — a durable preference, a decision, or something about the user or their setup. Not routine conversation.",
	}),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional short tags for later retrieval, e.g. ['preference', 'pion'].",
		}),
	),
});

type RememberParams = Static<typeof rememberSchema>;

export interface RememberDetails {
	file: string;
	date: string;
	success: boolean;
	error?: string;
}

/** Local-date filename stem, e.g. 2026-06-14. */
export function dailyStem(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Local HH:MM timestamp for the note line. */
function clockStamp(now: Date): string {
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

/** Directory holding the dated journal files. */
export function dailyDir(workspacePath: string): string {
	return join(expandTilde(workspacePath), "memory", "daily");
}

/**
 * Append one note to today's journal file, creating the folder and file
 * (with a date header) on first write of the day. Returns the file path.
 */
export function appendDailyNote(
	workspacePath: string,
	note: string,
	tags: string[] | undefined,
	now: Date,
): string {
	const dir = dailyDir(workspacePath);
	mkdirSync(dir, { recursive: true });

	const stem = dailyStem(now);
	const file = join(dir, `${stem}.md`);
	if (!existsSync(file)) {
		writeFileSync(file, `# ${stem}\n\n`, "utf-8");
	}

	const tagSuffix = tags && tags.length > 0 ? ` (${tags.map((tag) => `#${tag}`).join(" ")})` : "";
	const line = `- ${clockStamp(now)} — ${note.trim()}${tagSuffix}\n`;
	appendFileSync(file, line, "utf-8");

	return file;
}

/**
 * Create the native `remember` tool bound to an agent workspace.
 *
 * @param options.workspacePath - agent workspace; notes land in `<workspace>/memory/daily/`
 * @param options.now - clock injection point for tests (defaults to real time)
 */
export function createRememberTool(options: {
	workspacePath: string;
	now?: () => Date;
}): ToolDefinition<typeof rememberSchema, RememberDetails> {
	const now = options.now ?? (() => new Date());

	return {
		name: "remember",
		label: "Remember",
		description:
			"Save a single durable fact to your dated memory journal. Use when something is genuinely worth remembering across sessions — a user preference, a decision, a fact about their setup. One fact per call. Not for routine conversation.",
		promptSnippet:
			"remember(note, tags?) - save a durable fact to your memory journal so it carries into future sessions",
		promptGuidelines: [
			"Call remember when the user states a lasting preference, you reach a decision, or you learn a stable fact about the user or their environment.",
			"Keep each note to one concrete fact. Do not save routine chatter or things already written down.",
		],
		parameters: rememberSchema,

		async execute(
			_toolCallId: string,
			params: RememberParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<RememberDetails> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<RememberDetails>> {
			const note = params.note.trim();
			if (note.length === 0) {
				return {
					content: [{ type: "text", text: "Note must not be empty." }],
					details: { file: "", date: "", success: false, error: "empty note" },
				};
			}

			try {
				const when = now();
				const file = appendDailyNote(options.workspacePath, note, params.tags, when);
				return {
					content: [{ type: "text", text: `Noted in ${file}` }],
					details: { file, date: dailyStem(when), success: true },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to save note: ${message}` }],
					details: { file: "", date: "", success: false, error: message },
				};
			}
		},
	};
}
