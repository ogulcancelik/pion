/**
 * Native subagent tool — delegate a focused task to a peer AI model.
 *
 * The main agent calls `subagent` to hand a self-contained question or task to a
 * separate model running in its own context, then receives that model's final
 * reply. This is an uncommon escape hatch — a second opinion, a parallel
 * investigation, or a way to get unstuck — not a tool for routine work.
 *
 * The peer runs as a child `pi --mode rpc` process. We speak JSON-lines over its
 * stdin/stdout: send a `get_state` then a `prompt` command, accumulate the
 * streamed assistant text, and resolve on `agent_end`. The peer is one-shot:
 * each call spawns a fresh process with no persisted session.
 *
 * The spawn/RPC step is injectable via `runPeer` so tests never spawn a real
 * `pi` process or touch the network.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentProfileStore } from "./agent-profiles.js";

/** Default tools granted to the peer agent — read-only investigation. */
export const DEFAULT_PEER_TOOLS = "read,grep,find,ls";
/** Default per-call timeout for the peer in milliseconds (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** A peer model invocation, resolved into provider + id + tool list. */
export interface PeerRequest {
	/** pi provider, e.g. "openai". */
	provider: string;
	/** pi model id, e.g. "gpt-5.5". */
	modelId: string;
	/** Comma-separated pi tool list for the peer. */
	tools: string;
	/** The message/question for the peer. */
	task: string;
}

/** Outcome of running the peer once. */
export interface PeerResult {
	/** Final assistant text from the peer. */
	response: string;
	/** Set when the peer failed — surfaced to the caller as a tool error. */
	error?: string;
}

export type RunPeer = (request: PeerRequest, signal?: AbortSignal) => Promise<PeerResult>;

export interface SubagentToolOptions {
	/** Binary name or path for the peer pi CLI (default: "pi", resolved from PATH). */
	piBin?: string;
	/** Default peer model as a "provider/id" string when the call omits `model`. */
	defaultModel?: string;
	/** Saved agent profiles; a `model` arg matching a profile name resolves to it. */
	profiles?: AgentProfileStore;
	/** pi config dir for the peer (sets PI_CODING_AGENT_DIR) so it uses pion's auth.json. */
	piConfigDir?: string;
	/** Override the spawn/RPC runner. Injectable for tests. */
	runPeer?: RunPeer;
	/** Per-call timeout in milliseconds (default: 300000). */
	timeoutMs?: number;
}

const subagentSchema = Type.Object({
	task: Type.String({
		description:
			"The self-contained question or task for the peer model. Include all context it needs — it does not see this conversation.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Peer model as "provider/id" (e.g. "openai/gpt-5.5"). Prefer a different model family than your own. Defaults to the configured peer model.',
		}),
	),
	tools: Type.Optional(
		Type.String({
			description: `Comma-separated tools to grant the peer (default "${DEFAULT_PEER_TOOLS}", read-only). Widen only when the task truly needs it.`,
		}),
	),
});

type SubagentParams = Static<typeof subagentSchema>;

export interface SubagentDetails {
	error?: boolean;
	model?: string;
	tools?: string;
}

/** Split a "provider/id" model string. Returns undefined if malformed. */
function parsePeerModel(model: string): { provider: string; modelId: string } | undefined {
	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= model.length - 1) {
		return undefined;
	}
	return {
		provider: model.slice(0, slashIndex),
		modelId: model.slice(slashIndex + 1),
	};
}

function normalizeTools(tools: string | undefined): string {
	return (tools ?? DEFAULT_PEER_TOOLS)
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean)
		.join(",");
}

function extractTextFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					!!part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n\n");
	}
	return "";
}

/**
 * Build the env for the peer process. When `configDir` is set, point pi's
 * `PI_CODING_AGENT_DIR` at it so the peer reads the same `auth.json` (and thus
 * the same provider logins) that pion uses, rather than the peer's own `~/.pi`.
 */
export function buildPeerSpawnEnv(configDir?: string): NodeJS.ProcessEnv {
	if (!configDir) {
		return process.env;
	}
	return { ...process.env, PI_CODING_AGENT_DIR: configDir };
}

/**
 * Default peer runner. Spawns `pi --mode rpc` with no extensions, drives the
 * JSON-lines RPC protocol, accumulates streamed assistant text, and resolves on
 * `agent_end`. Enforces a timeout and honors the AbortSignal by killing the
 * child. Never throws — failures come back as `PeerResult.error`.
 */
export function createDefaultRunPeer(
	piBin: string,
	timeoutMs: number,
	configDir?: string,
): RunPeer {
	const env = buildPeerSpawnEnv(configDir);
	return (request, signal) =>
		new Promise<PeerResult>((resolve) => {
			if (signal?.aborted) {
				resolve({ response: "", error: "aborted" });
				return;
			}

			const args = [
				"--mode",
				"rpc",
				"--no-extensions",
				"--provider",
				request.provider,
				"--model",
				request.modelId,
				"--tools",
				request.tools,
			];

			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(piBin, args, { stdio: ["pipe", "pipe", "pipe"], env });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				resolve({ response: "", error: `failed to spawn ${piBin}: ${message}` });
				return;
			}

			let settled = false;
			let finished = false;
			let responseText = "";
			let stderr = "";

			const stdout = proc.stdout;
			if (!stdout) {
				resolve({ response: "", error: `failed to attach to ${piBin} stdout` });
				return;
			}
			const rl = createInterface({ input: stdout, terminal: false });

			const cleanup = () => {
				clearTimeout(timer);
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
				rl.close();
				try {
					proc.stdin?.end();
				} catch {}
				proc.kill("SIGTERM");
			};

			const settle = (result: PeerResult) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(result);
			};

			const fail = (error: string) => settle({ response: "", error });

			function onAbort() {
				finished = true;
				fail("aborted");
			}

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const timer = setTimeout(() => {
				finished = true;
				fail(`peer timed out after ${timeoutMs}ms`);
			}, timeoutMs);

			let reqId = 0;
			const sendCommand = (command: Record<string, unknown>) => {
				const id = `req-${++reqId}`;
				try {
					proc.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
			};

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			rl.on("line", (line) => {
				let event: { type?: string; [key: string]: unknown };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent as
						| { type?: string; delta?: string; reason?: string }
						| undefined;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						responseText += delta.delta;
					} else if (delta?.type === "error") {
						fail(delta.reason ?? "streaming error");
					}
					return;
				}

				if (event.type === "message_end") {
					const msg = event.message as { errorMessage?: string } | undefined;
					if (msg?.errorMessage) {
						fail(msg.errorMessage);
					}
					return;
				}

				if (event.type === "agent_end") {
					const messages = (event.messages as unknown[]) ?? [];
					if (responseText.trim() === "") {
						const lastAssistant = [...messages]
							.reverse()
							.find(
								(m) =>
									!!m && typeof m === "object" && (m as { role?: unknown }).role === "assistant",
							);
						responseText = extractTextFromMessage(lastAssistant);
					}
					finished = true;
					settle({ response: responseText.trim() });
					return;
				}

				if (event.type === "response" && event.success === false) {
					fail(typeof event.error === "string" ? event.error : "peer command failed");
					return;
				}

				if (event.type === "hook_error") {
					fail(typeof event.error === "string" ? `hook error: ${event.error}` : "hook error");
				}
			});

			proc.on("error", (error) => {
				fail(`failed to spawn ${piBin}: ${error.message}`);
			});

			proc.on("exit", (code, sig) => {
				if (!finished) {
					const detail = stderr.trim();
					fail(
						`peer exited unexpectedly (code=${code}, signal=${sig})${detail ? `: ${detail}` : ""}`,
					);
				}
			});

			sendCommand({ type: "get_state" });
			sendCommand({ type: "prompt", message: request.task });
		});
}

/**
 * Create the native `subagent` tool. Delegates a task to a peer `pi` model and
 * returns its reply. `execute` never throws: missing/invalid model, empty task,
 * spawn failure, peer error, timeout, and abort all return a tool result with
 * `details.error`.
 */
export function createSubagentTool(options: SubagentToolOptions): ToolDefinition {
	const piBin = options.piBin ?? "pi";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const runPeer = options.runPeer ?? createDefaultRunPeer(piBin, timeoutMs, options.piConfigDir);

	const tool: ToolDefinition<typeof subagentSchema, SubagentDetails> = {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a self-contained task to a peer AI model running in a separate context and get its reply. Use this uncommonly — for a second opinion, a parallel investigation, or when you are stuck — not for routine work. Prefer a different model family than your own. The peer does not see this conversation, so the task must include all context it needs.",
		promptSnippet:
			"subagent(task, model?, tools?) - delegate a self-contained task to a peer model and return its reply",
		promptGuidelines: [
			"Use subagent rarely: a second opinion, a parallel investigation, or to get unstuck — not for routine work you can do yourself.",
			"The task must be self-contained; the peer cannot see this conversation.",
			"Prefer a different model family for the peer when possible. The peer is read-only by default.",
		],
		parameters: subagentSchema,
		async execute(_toolCallId, params: SubagentParams, signal: AbortSignal | undefined) {
			const task = params.task.trim();
			if (task.length === 0) {
				return {
					content: [{ type: "text", text: "Task must not be empty." }],
					details: { error: true },
				};
			}

			const aliasName = params.model?.trim() || undefined;
			const profile = aliasName ? options.profiles?.get(aliasName) : undefined;
			const modelString = profile?.model ?? aliasName ?? options.defaultModel?.trim() ?? "";
			if (modelString.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: 'No peer model available. Pass model as "provider/id" (e.g. "openai/gpt-5.5").',
						},
					],
					details: { error: true },
				};
			}

			const parsed = parsePeerModel(modelString);
			if (!parsed) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid model "${modelString}". Use "provider/id", e.g. "openai/gpt-5.5".`,
						},
					],
					details: { error: true, model: modelString },
				};
			}

			const tools = normalizeTools(params.tools ?? profile?.tools);
			const peerTask = profile?.systemPrompt ? `${profile.systemPrompt}\n\n${task}` : task;

			let result: PeerResult;
			try {
				result = await runPeer(
					{ provider: parsed.provider, modelId: parsed.modelId, tools, task: peerTask },
					signal,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `subagent failed: ${message}` }],
					details: { error: true, model: modelString, tools },
				};
			}

			if (result.error) {
				return {
					content: [{ type: "text", text: `subagent (${modelString}) failed: ${result.error}` }],
					details: { error: true, model: modelString, tools },
				};
			}

			if (result.response.trim().length === 0) {
				return {
					content: [{ type: "text", text: `Peer (${modelString}) returned an empty reply.` }],
					details: { error: true, model: modelString, tools },
				};
			}

			return {
				content: [{ type: "text", text: result.response }],
				details: { model: modelString, tools },
			};
		},
	};

	return tool as unknown as ToolDefinition;
}
