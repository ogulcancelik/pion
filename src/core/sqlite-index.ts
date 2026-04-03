import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "./runtime-events.js";

const ATTACHMENT_LINE_PATTERN = /\[User attached (image|video|audio|document): ([^\]]+)\]/g;

export interface IndexedSessionMessage {
	sessionFile: string;
	entryId: string;
	parentId: string | null;
	timestamp: string;
	role: string;
	text: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costTotal?: number;
}

export interface IndexedToolCall {
	sessionFile: string;
	entryId: string;
	toolCallId: string;
	timestamp: string;
	toolName: string;
	path?: string;
	command?: string;
	argumentsJson: string;
}

export interface IndexedAttachment {
	sessionFile: string;
	entryId: string;
	timestamp: string;
	kind: string;
	path: string;
}

export interface IndexedRuntimeEvent {
	id: string;
	logFile: string;
	timestamp: string;
	source: string;
	contextKey: string;
	sessionFile?: string;
	eventType: string;
	provider?: string;
	chatId?: string;
	messageId?: string;
	senderId?: string;
	isGroup?: number;
	outcome?: string;
	errorMessage?: string;
	reason?: string;
	warning?: string;
	text?: string;
	mediaCount?: number;
	messageCount?: number;
	messagesSent?: number;
	responseLength?: number;
	toolName?: string;
	toolCallId?: string;
	toolPath?: string;
	toolCommand?: string;
	payloadJson: string;
}

type IndexedFileKind = "session" | "runtime_event_log";

type SessionMessageEntry = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		model?: string;
		stopReason?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

type SessionHeaderEntry = {
	type: "session";
	id?: string;
	timestamp?: string;
	cwd?: string;
};

type ToolCallContent = {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type TextContent = { type: "text"; text?: string };
type ImageContent = { type: "image" };
type GenericContent = { type?: string } & Record<string, unknown>;

function safeJsonParse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function walkJsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkJsonlFiles(path));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path);
		}
	}
	return files.sort();
}

function stringifyJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function extractMessageText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const part of content as GenericContent[]) {
		if (part.type === "text") {
			parts.push((part as TextContent).text ?? "");
			continue;
		}
		if (part.type === "image") {
			parts.push("[image]");
		}
	}

	return parts.join("\n").trim();
}

function extractToolCalls(content: unknown): ToolCallContent[] {
	if (!Array.isArray(content)) {
		return [];
	}

	return (content as GenericContent[]).filter(
		(part) => part.type === "toolCall",
	) as ToolCallContent[];
}

function parseAttachments(text: string): Array<{ kind: string; path: string }> {
	const matches: Array<{ kind: string; path: string }> = [];
	for (const match of text.matchAll(ATTACHMENT_LINE_PATTERN)) {
		const kind = match[1];
		const path = match[2];
		if (kind && path) {
			matches.push({ kind, path });
		}
	}
	return matches;
}

function resolveEntryTimestamp(entry: SessionMessageEntry, fallbackTimestamp?: string): string {
	if (entry.timestamp) {
		return entry.timestamp;
	}
	const rawMessage = entry.message as Record<string, unknown> | undefined;
	const messageTimestamp = rawMessage?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
		return new Date(messageTimestamp).toISOString();
	}
	return fallbackTimestamp ?? new Date(0).toISOString();
}

function runtimeLogFileFor(dataDir: string, contextKey: string): string {
	return join(dataDir, "runtime-events", `${contextKey.replace(/[:/\\]/g, "-")}.jsonl`);
}

export class PionSqliteIndex {
	private dbPath: string;
	private sessionsDir: string;
	private runtimeEventsDir: string;
	private db: Database;

	constructor(private dataDir: string) {
		this.dbPath = join(dataDir, "index.sqlite");
		this.sessionsDir = join(dataDir, "sessions");
		this.runtimeEventsDir = join(dataDir, "runtime-events");
		this.db = new Database(this.dbPath, { create: true, strict: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.createSchema();
		this.reindexAll();
	}

	close(): void {
		this.db.close();
	}

	getDatabasePath(): string {
		return this.dbPath;
	}

	reindexAll(): void {
		const seenFiles = new Set<string>();

		for (const sessionFile of walkJsonlFiles(this.sessionsDir)) {
			seenFiles.add(sessionFile);
			this.syncSessionFile(sessionFile);
		}

		for (const runtimeLogFile of walkJsonlFiles(this.runtimeEventsDir)) {
			seenFiles.add(runtimeLogFile);
			this.syncRuntimeEventLog(runtimeLogFile);
		}

		const staleFiles = this.db.query("SELECT path, kind FROM indexed_files").all() as Array<{
			path: string;
			kind: IndexedFileKind;
		}>;
		for (const file of staleFiles) {
			if (seenFiles.has(file.path)) {
				continue;
			}
			if (file.kind === "session") {
				this.removeSessionFile(file.path);
			} else {
				this.removeRuntimeEventLog(file.path);
			}
		}
	}

	syncSessionFile(sessionFile: string): void {
		if (!existsSync(sessionFile)) {
			this.removeSessionFile(sessionFile);
			return;
		}

		if (!this.shouldReindexFile(sessionFile, "session")) {
			return;
		}

		const content = readFileSync(sessionFile, "utf-8");
		const lines = content.split("\n").filter((line) => line.trim().length > 0);
		const entries = lines.map(safeJsonParse).filter(Boolean) as Array<
			SessionHeaderEntry | SessionMessageEntry
		>;
		const header = entries.find((entry) => entry.type === "session") as
			| SessionHeaderEntry
			| undefined;
		const messages = entries.filter((entry) => entry.type === "message") as SessionMessageEntry[];

		const transaction = this.db.transaction(() => {
			this.db.query("DELETE FROM sessions WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM session_messages WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM tool_calls WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM attachments WHERE session_file = ?1").run(sessionFile);

			this.db
				.query(
					`INSERT INTO sessions (
						session_file, session_id, cwd, created_at, modified_at, message_count
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
				)
				.run(
					sessionFile,
					header?.id ?? null,
					header?.cwd ?? null,
					header?.timestamp ?? messages[0]?.timestamp ?? null,
					messages.at(-1)?.timestamp ?? header?.timestamp ?? null,
					messages.length,
				);

			for (const [messageIndex, entry] of messages.entries()) {
				const entryId = entry.id || `legacy-message-${messageIndex}`;
				const entryTimestamp = resolveEntryTimestamp(entry, header?.timestamp);
				const message = entry.message;
				const text = extractMessageText(message?.content);
				const role = message?.role ?? "unknown";
				this.db
					.query(
						`INSERT INTO session_messages (
							session_file, entry_id, parent_id, timestamp, role, text, provider, model,
							stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
							cost_total, content_json
						) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
					)
					.run(
						sessionFile,
						entryId,
						entry.parentId,
						entryTimestamp,
						role,
						text,
						message?.provider ?? null,
						message?.model ?? null,
						message?.stopReason ?? null,
						message?.usage?.input ?? null,
						message?.usage?.output ?? null,
						message?.usage?.cacheRead ?? null,
						message?.usage?.cacheWrite ?? null,
						message?.usage?.cost?.total ?? null,
						stringifyJson(message?.content),
					);

				for (const [ordinal, attachment] of parseAttachments(text).entries()) {
					this.db
						.query(
							`INSERT INTO attachments (
								session_file, entry_id, timestamp, ordinal, kind, path
							) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
						)
						.run(sessionFile, entryId, entryTimestamp, ordinal, attachment.kind, attachment.path);
				}

				for (const [index, toolCall] of extractToolCalls(message?.content).entries()) {
					const toolCallId = toolCall.id ?? `${entryId}:tool:${index}`;
					const args = toolCall.arguments ?? {};
					this.db
						.query(
							`INSERT INTO tool_calls (
								session_file, entry_id, tool_call_id, timestamp, tool_name, path, command, arguments_json
							) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
						)
						.run(
							sessionFile,
							entryId,
							toolCallId,
							entryTimestamp,
							toolCall.name ?? "unknown",
							typeof args.path === "string" ? args.path : null,
							typeof args.command === "string" ? args.command : null,
							stringifyJson(args),
						);
				}
			}
		});

		transaction();
		this.recordIndexedFile(sessionFile, "session");
	}

	removeSessionFile(sessionFile: string): void {
		const transaction = this.db.transaction(() => {
			this.db.query("DELETE FROM sessions WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM session_messages WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM tool_calls WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM attachments WHERE session_file = ?1").run(sessionFile);
			this.db.query("DELETE FROM indexed_files WHERE path = ?1").run(sessionFile);
		});
		transaction();
	}

	recordRuntimeEvent(event: RuntimeEvent): void {
		const logFile = runtimeLogFileFor(this.dataDir, event.contextKey);
		this.insertRuntimeEvent(logFile, event);
		if (existsSync(logFile)) {
			this.recordIndexedFile(logFile, "runtime_event_log");
		}
	}

	syncRuntimeEventLog(runtimeLogFile: string): void {
		if (!existsSync(runtimeLogFile)) {
			this.removeRuntimeEventLog(runtimeLogFile);
			return;
		}

		if (!this.shouldReindexFile(runtimeLogFile, "runtime_event_log")) {
			return;
		}

		const lines = readFileSync(runtimeLogFile, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		const events = lines.map(safeJsonParse).filter(Boolean) as RuntimeEvent[];

		const transaction = this.db.transaction(() => {
			this.db.query("DELETE FROM runtime_events WHERE log_file = ?1").run(runtimeLogFile);
			for (const event of events) {
				this.insertRuntimeEvent(runtimeLogFile, event);
			}
		});
		transaction();
		this.recordIndexedFile(runtimeLogFile, "runtime_event_log");
	}

	removeRuntimeEventLog(runtimeLogFile: string): void {
		const transaction = this.db.transaction(() => {
			this.db.query("DELETE FROM runtime_events WHERE log_file = ?1").run(runtimeLogFile);
			this.db.query("DELETE FROM indexed_files WHERE path = ?1").run(runtimeLogFile);
		});
		transaction();
	}

	getRecentMessages(limit = 20): IndexedSessionMessage[] {
		return this.db
			.query(
				`SELECT session_file AS sessionFile, entry_id AS entryId, parent_id AS parentId,
					timestamp, role, text, provider, model, stop_reason AS stopReason,
					input_tokens AS inputTokens, output_tokens AS outputTokens,
					cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
					cost_total AS costTotal
				 FROM session_messages
				 ORDER BY timestamp DESC, entry_id DESC
				 LIMIT ?1`,
			)
			.all(limit) as IndexedSessionMessage[];
	}

	searchSessionMessages(query: string, limit = 20): IndexedSessionMessage[] {
		return this.db
			.query(
				`SELECT session_file AS sessionFile, entry_id AS entryId, parent_id AS parentId,
					timestamp, role, text, provider, model, stop_reason AS stopReason,
					input_tokens AS inputTokens, output_tokens AS outputTokens,
					cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
					cost_total AS costTotal
				 FROM session_messages
				 WHERE text LIKE '%' || ?1 || '%' COLLATE NOCASE
				 ORDER BY timestamp DESC, entry_id DESC
				 LIMIT ?2`,
			)
			.all(query, limit) as IndexedSessionMessage[];
	}

	listToolCalls(limit = 20): IndexedToolCall[] {
		return this.db
			.query(
				`SELECT session_file AS sessionFile, entry_id AS entryId, tool_call_id AS toolCallId,
					timestamp, tool_name AS toolName, path, command, arguments_json AS argumentsJson
				 FROM tool_calls
				 ORDER BY timestamp DESC, tool_call_id DESC
				 LIMIT ?1`,
			)
			.all(limit) as IndexedToolCall[];
	}

	listAttachments(limit = 20): IndexedAttachment[] {
		return this.db
			.query(
				`SELECT session_file AS sessionFile, entry_id AS entryId, timestamp, kind, path
				 FROM attachments
				 ORDER BY timestamp DESC, ordinal ASC
				 LIMIT ?1`,
			)
			.all(limit) as IndexedAttachment[];
	}

	getRecentRuntimeEvents(limit = 20): IndexedRuntimeEvent[] {
		return this.db
			.query(
				`SELECT id, log_file AS logFile, timestamp, source, context_key AS contextKey,
					session_file AS sessionFile, event_type AS eventType, provider, chat_id AS chatId,
					message_id AS messageId, sender_id AS senderId, is_group AS isGroup,
					outcome, error_message AS errorMessage, reason, warning, text, media_count AS mediaCount,
					message_count AS messageCount, messages_sent AS messagesSent,
					response_length AS responseLength, tool_name AS toolName,
					tool_call_id AS toolCallId, tool_path AS toolPath, tool_command AS toolCommand,
					payload_json AS payloadJson
				 FROM runtime_events
				 ORDER BY timestamp DESC, id DESC
				 LIMIT ?1`,
			)
			.all(limit) as IndexedRuntimeEvent[];
	}

	searchRuntimeEvents(query: string, limit = 20): IndexedRuntimeEvent[] {
		return this.db
			.query(
				`SELECT id, log_file AS logFile, timestamp, source, context_key AS contextKey,
					session_file AS sessionFile, event_type AS eventType, provider, chat_id AS chatId,
					message_id AS messageId, sender_id AS senderId, is_group AS isGroup,
					outcome, error_message AS errorMessage, reason, warning, text, media_count AS mediaCount,
					message_count AS messageCount, messages_sent AS messagesSent,
					response_length AS responseLength, tool_name AS toolName,
					tool_call_id AS toolCallId, tool_path AS toolPath, tool_command AS toolCommand,
					payload_json AS payloadJson
				 FROM runtime_events
				 WHERE COALESCE(text, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
					OR COALESCE(error_message, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
					OR COALESCE(warning, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
					OR COALESCE(tool_name, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
					OR COALESCE(tool_path, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
					OR COALESCE(tool_command, '') LIKE '%' || ?1 || '%' COLLATE NOCASE
				 ORDER BY timestamp DESC, id DESC
				 LIMIT ?2`,
			)
			.all(query, limit) as IndexedRuntimeEvent[];
	}

	private createSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS indexed_files (
				path TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				mtime_ms INTEGER NOT NULL,
				size INTEGER NOT NULL,
				indexed_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS sessions (
				session_file TEXT PRIMARY KEY,
				session_id TEXT,
				cwd TEXT,
				created_at TEXT,
				modified_at TEXT,
				message_count INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS session_messages (
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				parent_id TEXT,
				timestamp TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				provider TEXT,
				model TEXT,
				stop_reason TEXT,
				input_tokens INTEGER,
				output_tokens INTEGER,
				cache_read_tokens INTEGER,
				cache_write_tokens INTEGER,
				cost_total REAL,
				content_json TEXT NOT NULL,
				PRIMARY KEY (session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_session_messages_role ON session_messages(role);

			CREATE TABLE IF NOT EXISTS tool_calls (
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				path TEXT,
				command TEXT,
				arguments_json TEXT NOT NULL,
				PRIMARY KEY (session_file, tool_call_id)
			);
			CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

			CREATE TABLE IF NOT EXISTS attachments (
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				kind TEXT NOT NULL,
				path TEXT NOT NULL,
				PRIMARY KEY (session_file, entry_id, ordinal)
			);
			CREATE INDEX IF NOT EXISTS idx_attachments_timestamp ON attachments(timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_attachments_kind ON attachments(kind);

			CREATE TABLE IF NOT EXISTS runtime_events (
				id TEXT PRIMARY KEY,
				log_file TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				source TEXT NOT NULL,
				context_key TEXT NOT NULL,
				session_file TEXT,
				event_type TEXT NOT NULL,
				provider TEXT,
				chat_id TEXT,
				message_id TEXT,
				sender_id TEXT,
				is_group INTEGER,
				outcome TEXT,
				error_message TEXT,
				reason TEXT,
				warning TEXT,
				text TEXT,
				media_count INTEGER,
				message_count INTEGER,
				messages_sent INTEGER,
				response_length INTEGER,
				tool_name TEXT,
				tool_call_id TEXT,
				tool_path TEXT,
				tool_command TEXT,
				payload_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_runtime_events_timestamp ON runtime_events(timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_runtime_events_context_key ON runtime_events(context_key);
			CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(event_type);
		`);
	}

	private shouldReindexFile(path: string, kind: IndexedFileKind): boolean {
		const fileStat = statSync(path);
		const existing = this.db
			.query("SELECT mtime_ms AS mtimeMs, size FROM indexed_files WHERE path = ?1 AND kind = ?2")
			.get(path, kind) as { mtimeMs: number; size: number } | null;
		if (!existing) {
			return true;
		}
		return existing.mtimeMs !== Math.trunc(fileStat.mtimeMs) || existing.size !== fileStat.size;
	}

	private recordIndexedFile(path: string, kind: IndexedFileKind): void {
		const fileStat = statSync(path);
		this.db
			.query(
				`INSERT INTO indexed_files (path, kind, mtime_ms, size, indexed_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(path) DO UPDATE SET
					kind = excluded.kind,
					mtime_ms = excluded.mtime_ms,
					size = excluded.size,
					indexed_at = excluded.indexed_at`,
			)
			.run(path, kind, Math.trunc(fileStat.mtimeMs), fileStat.size, new Date().toISOString());
	}

	private insertRuntimeEvent(logFile: string, event: RuntimeEvent): void {
		const extracted = this.extractRuntimeEventFields(event);
		this.db
			.query(
				`INSERT OR REPLACE INTO runtime_events (
					id, log_file, timestamp, source, context_key, session_file, event_type, provider,
					chat_id, message_id, sender_id, is_group, outcome, error_message, reason, warning,
					text, media_count, message_count, messages_sent, response_length,
					tool_name, tool_call_id, tool_path, tool_command, payload_json
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
					?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
					?17, ?18, ?19, ?20, ?21,
					?22, ?23, ?24, ?25, ?26
				)`,
			)
			.run(
				event.id,
				logFile,
				event.timestamp,
				event.source,
				event.contextKey,
				event.source === "pi" ? event.sessionFile : null,
				event.type,
				extracted.provider,
				extracted.chatId,
				extracted.messageId,
				extracted.senderId,
				extracted.isGroup,
				extracted.outcome,
				extracted.errorMessage,
				extracted.reason,
				extracted.warning,
				extracted.text,
				extracted.mediaCount,
				extracted.messageCount,
				extracted.messagesSent,
				extracted.responseLength,
				extracted.toolName,
				extracted.toolCallId,
				extracted.toolPath,
				extracted.toolCommand,
				stringifyJson(event),
			);
	}

	private extractRuntimeEventFields(event: RuntimeEvent): {
		provider: string | null;
		chatId: string | null;
		messageId: string | null;
		senderId: string | null;
		isGroup: number | null;
		outcome: string | null;
		errorMessage: string | null;
		reason: string | null;
		warning: string | null;
		text: string | null;
		mediaCount: number | null;
		messageCount: number | null;
		messagesSent: number | null;
		responseLength: number | null;
		toolName: string | null;
		toolCallId: string | null;
		toolPath: string | null;
		toolCommand: string | null;
	} {
		if (event.source === "pion") {
			return {
				provider: "provider" in event ? event.provider : null,
				chatId: "chatId" in event ? event.chatId : null,
				messageId: "messageId" in event ? event.messageId : null,
				senderId: "senderId" in event ? event.senderId : null,
				isGroup: "isGroup" in event ? Number(event.isGroup) : null,
				outcome: event.type === "runtime_processing_complete" ? event.outcome : null,
				errorMessage:
					event.type === "runtime_processing_complete" ? (event.errorMessage ?? null) : null,
				reason: event.type === "runtime_superseded" ? event.reason : null,
				warning: event.type === "runtime_warning_emitted" ? event.warning : null,
				text:
					event.type === "runtime_message_received" || event.type === "runtime_output_sent"
						? event.text
						: null,
				mediaCount: event.type === "runtime_message_received" ? event.mediaCount : null,
				messageCount:
					event.type === "runtime_message_buffered" || event.type === "runtime_messages_merged"
						? event.messageCount
						: null,
				messagesSent: event.type === "runtime_processing_complete" ? event.messagesSent : null,
				responseLength: event.type === "runtime_processing_complete" ? event.responseLength : null,
				toolName: null,
				toolCallId: null,
				toolPath: null,
				toolCommand: null,
			};
		}

		const piEvent = event.event as Record<string, unknown>;
		const args = (
			typeof piEvent.args === "object" && piEvent.args !== null
				? (piEvent.args as Record<string, unknown>)
				: typeof piEvent.arguments === "object" && piEvent.arguments !== null
					? (piEvent.arguments as Record<string, unknown>)
					: {}
		) as Record<string, unknown>;
		return {
			provider: null,
			chatId: null,
			messageId: null,
			senderId: null,
			isGroup: null,
			outcome: null,
			errorMessage: null,
			reason: null,
			warning: null,
			text: null,
			mediaCount: null,
			messageCount: null,
			messagesSent: null,
			responseLength: null,
			toolName: typeof piEvent.toolName === "string" ? piEvent.toolName : null,
			toolCallId: typeof piEvent.toolCallId === "string" ? piEvent.toolCallId : null,
			toolPath: typeof args.path === "string" ? args.path : null,
			toolCommand: typeof args.command === "string" ? args.command : null,
		};
	}
}
