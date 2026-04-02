import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Runner,
	UserFacingError,
	buildPromptTextWithMediaPaths,
	buildRuntimeErrorSystemPrompt,
	classifyRuntimeError,
	findRetryBranchParentId,
	materializeMediaAttachments,
	parseModelString,
	resolveFetchedImageMimeType,
} from "../../src/core/runner.js";

describe("Runner", () => {
	const testDir = join(import.meta.dir, ".test-runner");
	let runner: Runner;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		runner = new Runner({ dataDir: testDir });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("constructor", () => {
		test("creates data directory and sessions subdirectory", () => {
			expect(existsSync(testDir)).toBe(true);
			expect(existsSync(join(testDir, "sessions"))).toBe(true);
		});
	});

	describe("getSessionFile", () => {
		test("converts colons to hyphens", () => {
			const result = runner.getSessionFile("telegram:contact:123");
			expect(result).toBe(join(testDir, "sessions", "telegram-contact-123.jsonl"));
		});

		test("converts slashes to hyphens", () => {
			const result = runner.getSessionFile("whatsapp/chat/group-xyz");
			expect(result).toBe(join(testDir, "sessions", "whatsapp-chat-group-xyz.jsonl"));
		});

		test("converts backslashes to hyphens", () => {
			const result = runner.getSessionFile("some\\back\\slash");
			expect(result).toBe(join(testDir, "sessions", "some-back-slash.jsonl"));
		});

		test("handles mixed special characters", () => {
			const result = runner.getSessionFile("tg:group/chat\\test:456");
			expect(result).toBe(join(testDir, "sessions", "tg-group-chat-test-456.jsonl"));
		});

		test("preserves already-safe keys", () => {
			const result = runner.getSessionFile("simple-key-123");
			expect(result).toBe(join(testDir, "sessions", "simple-key-123.jsonl"));
		});
	});

	describe("clearSession", () => {
		test("returns false when no active session exists", () => {
			const result = runner.clearSession("nonexistent:key");
			expect(result).toBe(false);
		});

		test("archives existing session file", () => {
			const contextKey = "telegram:contact:999";
			const sessionFile = runner.getSessionFile(contextKey);

			// Write a fake session file with a timestamp in the first entry
			const timestamp = "2025-01-15T10:30:00.000Z";
			const sessionEntry = JSON.stringify({ type: "session", version: 3, id: "test", timestamp });
			const messageEntry = JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Hello" }] },
			});
			writeFileSync(sessionFile, `${sessionEntry}\n${messageEntry}\n`);

			runner.clearSession(contextKey);

			// Original file should be gone
			expect(existsSync(sessionFile)).toBe(false);

			// Archive directory should exist
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(true);

			// Archived file should exist with timestamp slug
			// "2025-01-15T10:30:00.000Z" → "2025-01-15T10-30" after slice(0,16) + replace
			const expectedArchive = join(archiveDir, "telegram-contact-999-2025-01-15T10-30.jsonl");
			expect(existsSync(expectedArchive)).toBe(true);

			// Content should be preserved
			const archivedContent = readFileSync(expectedArchive, "utf-8");
			expect(archivedContent).toContain("Hello");
		});

		test("creates archive directory if it doesn't exist", () => {
			const contextKey = "test:archive:dir";
			const sessionFile = runner.getSessionFile(contextKey);
			const archiveDir = join(testDir, "sessions", "archive");

			// Ensure archive dir doesn't exist yet
			expect(existsSync(archiveDir)).toBe(false);

			// Write a session file
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", timestamp: "2025-06-01T12:00:00Z" })}\n`,
			);

			runner.clearSession(contextKey);

			expect(existsSync(archiveDir)).toBe(true);
		});

		test("handles archive collision (same minute)", () => {
			const contextKey = "telegram:contact:collision";
			const sessionFile = runner.getSessionFile(contextKey);
			const archiveDir = join(testDir, "sessions", "archive");
			mkdirSync(archiveDir, { recursive: true });

			const timestamp = "2025-03-10T14:20:00.000Z";
			const slug = "2025-03-10T14-20";
			const safeKey = "telegram-contact-collision";

			// Pre-create an archive file to force collision
			const existingArchive = join(archiveDir, `${safeKey}-${slug}.jsonl`);
			writeFileSync(existingArchive, "existing\n");

			// Write session file
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", timestamp })}\n`);

			runner.clearSession(contextKey);

			// Should create a -1 suffixed file
			const collisionArchive = join(archiveDir, `${safeKey}-${slug}-1.jsonl`);
			expect(existsSync(collisionArchive)).toBe(true);

			// Original archive should still be there
			expect(existsSync(existingArchive)).toBe(true);
		});

		test("does nothing to files when session file doesn't exist", () => {
			const contextKey = "no:file:exists";

			// No session file on disk
			runner.clearSession(contextKey);

			// Archive dir should not be created (no file to archive)
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(false);
		});

		test("resets warning state", () => {
			// We can't directly check warningState (private), but clearSession
			// should not throw when clearing non-existent warning state
			expect(() => runner.clearSession("some:key")).not.toThrow();
		});
	});

	describe("primeSessionWithSummary", () => {
		test("creates a valid JSONL file", () => {
			const contextKey = "telegram:contact:prime";
			runner.primeSessionWithSummary(contextKey, "User asked about weather and got a forecast.");

			const sessionFile = runner.getSessionFile(contextKey);
			expect(existsSync(sessionFile)).toBe(true);

			const content = readFileSync(sessionFile, "utf-8");
			const lines = content.trim().split("\n");

			// Should have exactly 2 lines: session header + user message
			expect(lines.length).toBe(2);

			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});

		test("session header has correct format", () => {
			runner.primeSessionWithSummary("test:session:header", "Summary text");

			const sessionFile = runner.getSessionFile("test:session:header");
			const content = readFileSync(sessionFile, "utf-8");
			const firstLine = JSON.parse(content.split("\n")[0] || "{}");

			expect(firstLine.type).toBe("session");
			expect(firstLine.version).toBe(3);
			expect(firstLine.id).toMatch(/^compacted-/);
			expect(firstLine.timestamp).toBeDefined();
			expect(firstLine.cwd).toBeDefined();
		});

		test("user message wraps summary with prefix", () => {
			const summary = "User discussed API design for a REST endpoint.";
			runner.primeSessionWithSummary("test:summary:wrap", summary);

			const sessionFile = runner.getSessionFile("test:summary:wrap");
			const content = readFileSync(sessionFile, "utf-8");
			const secondLine = JSON.parse(content.split("\n")[1] || "{}");

			expect(secondLine.type).toBe("message");
			expect(secondLine.id).toMatch(/^summary-/);
			expect(secondLine.message.role).toBe("user");
			expect(secondLine.message.content).toBeArrayOfSize(1);
			expect(secondLine.message.content[0].type).toBe("text");
			expect(secondLine.message.content[0].text).toBe(`[Previous session summary]\n\n${summary}`);
		});

		test("archives existing session before priming", () => {
			const contextKey = "test:prime:archive";
			const sessionFile = runner.getSessionFile(contextKey);

			// Write an existing session
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", timestamp: "2025-01-01T00:00:00Z" })}\n`,
			);

			// Prime with new summary (should archive old one first)
			runner.primeSessionWithSummary(contextKey, "New summary");

			// Old session should be archived
			const archiveDir = join(testDir, "sessions", "archive");
			expect(existsSync(archiveDir)).toBe(true);

			// New session file should exist with new content
			expect(existsSync(sessionFile)).toBe(true);
			const content = readFileSync(sessionFile, "utf-8");
			expect(content).toContain("New summary");
			expect(content).not.toContain("2025-01-01T00:00:00Z");
		});
	});

	describe("getActiveContextKeys", () => {
		test("returns empty array when no sessions exist", () => {
			expect(runner.getActiveContextKeys()).toEqual([]);
		});
	});

	describe("isStreaming", () => {
		test("returns false for unknown context key", () => {
			expect(runner.isStreaming("unknown:key")).toBe(false);
		});
	});

	describe("steer", () => {
		test("returns false for unknown context key", () => {
			const result = runner.steer("unknown:key", "change direction");
			expect(result).resolves.toBe(false);
		});
	});

	describe("abort", () => {
		test("returns false for unknown context key", async () => {
			expect(await runner.abort("unknown:key")).toBe(false);
		});
	});

	describe("process", () => {
		test("uses runner-scoped model registry for custom provider auth", async () => {
			const workspaceDir = join(testDir, "agents", "main");
			mkdirSync(workspaceDir, { recursive: true });
			writeFileSync(join(workspaceDir, "IDENTITY.md"), "test agent\n");
			writeFileSync(
				join(workspaceDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"test-provider": {
								baseUrl: "http://127.0.0.1:1/v1",
								apiKey: "TEST_PROVIDER_API_KEY",
								api: "openai-completions",
								models: [
									{
										id: "demo-model",
										name: "Demo Model",
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 4096,
										maxTokens: 256,
									},
								],
							},
						},
					},
					null,
					2,
				)}\n`,
			);
			writeFileSync(
				join(testDir, "auth.json"),
				`${JSON.stringify(
					{
						"test-provider": {
							type: "api_key",
							key: "test-secret-key",
						},
					},
					null,
					2,
				)}\n`,
			);

			const isolatedRunner = new Runner({
				dataDir: testDir,
				authPath: join(testDir, "auth.json"),
			});

			type TestRunnerSession = {
				initialize(): Promise<void>;
				agentSession: {
					modelRegistry: {
						find(provider: string, modelId: string): unknown;
						hasConfiguredAuth(model: unknown): boolean;
					};
				};
				config: {
					modelRegistry: unknown;
				};
			};
			const createSession = (
				isolatedRunner as unknown as {
					createSession(context: {
						contextKey: string;
						agentConfig: { model: string; workspace: string; skills: string[] };
					}): Promise<TestRunnerSession>;
				}
			).createSession.bind(isolatedRunner);

			const session = await createSession({
				contextKey: "telegram:contact:user-1",
				agentConfig: {
					model: "test-provider/demo-model",
					workspace: workspaceDir,
					skills: [],
				},
			});

			await session.initialize();

			expect(session.agentSession).toBeDefined();
			expect(session.agentSession.modelRegistry).toBe(
				session.config.modelRegistry as TestRunnerSession["agentSession"]["modelRegistry"],
			);
			const model = session.agentSession.modelRegistry.find("test-provider", "demo-model");
			expect(model).toBeDefined();
			expect(session.agentSession.modelRegistry.hasConfiguredAuth(model)).toBe(true);
		});
	});

	describe("incoming media handling", () => {
		test("saves image attachments to disk and references the saved path in prompt text", async () => {
			const mediaDir = join(testDir, "media");
			const attachments = await materializeMediaAttachments(
				{
					id: "msg-1",
					chatId: "chat-1",
					senderId: "user-1",
					text: "[image]",
					isGroup: false,
					provider: "telegram",
					timestamp: new Date("2026-04-02T15:00:00Z"),
					raw: {},
					media: [
						{ type: "image", buffer: Buffer.from("fake image bytes"), mimeType: "image/png" },
					],
				},
				mediaDir,
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0]?.type).toBe("image");
			expect(attachments[0]?.path.endsWith(".png")).toBe(true);
			expect(existsSync(attachments[0]?.path || "")).toBe(true);
			expect(buildPromptTextWithMediaPaths("[image]", attachments)).toBe(
				`[User attached image: ${attachments[0]?.path}]`,
			);
		});

		test("keeps user text and appends one line per saved attachment path", () => {
			const prompt = buildPromptTextWithMediaPaths("look at these", [
				{ type: "image", path: "/tmp/one.jpg" },
				{ type: "image", path: "/tmp/two.png" },
			]);

			expect(prompt).toBe(
				"look at these\n\n[User attached image: /tmp/one.jpg]\n[User attached image: /tmp/two.png]",
			);
		});

		test("runner.process sends attachment paths as text and no inline images", async () => {
			const fakePrompt = async (
				text: string,
				images: Array<{ type: "image"; data: string; mimeType: string }> | undefined,
			) => {
				captured.text = text;
				captured.images = images;
				return "ok";
			};
			const captured: {
				text?: string;
				images?: Array<{ type: "image"; data: string; mimeType: string }>;
			} = {};
			const fakeSession = {
				prompt: fakePrompt,
				getContextUsage: () => null,
			};
			const testRunner = new Runner({ dataDir: testDir });
			(
				testRunner as unknown as {
					createSession(): Promise<typeof fakeSession>;
				}
			).createSession = async () => fakeSession;

			const result = await testRunner.process(
				{
					id: "msg-2",
					chatId: "chat-1",
					senderId: "user-1",
					text: "can you inspect this",
					isGroup: false,
					provider: "telegram",
					timestamp: new Date("2026-04-02T15:01:00Z"),
					raw: {},
					media: [
						{ type: "image", buffer: Buffer.from("fake image bytes"), mimeType: "image/jpeg" },
					],
				},
				{
					contextKey: "telegram:contact:user-1",
					agentConfig: {
						model: "anthropic/claude-sonnet-4-20250514",
						workspace: join(testDir, "agents", "main"),
						skills: [],
					},
				},
			);

			expect(result.response).toBe("ok");
			expect(captured.images).toBeUndefined();
			expect(captured.text).toContain("can you inspect this");
			expect(captured.text).toContain("[User attached image:");
			const match = captured.text?.match(/\[User attached image: (.+)\]/);
			expect(match).toBeDefined();
			expect(match?.[1]?.startsWith(join(tmpdir(), "pion-media"))).toBe(true);
			expect(existsSync(match?.[1] || "")).toBe(true);
		});

		test("runner.process forwards structured runtime events alongside text callbacks", async () => {
			const seenTexts: string[] = [];
			const seenEvents: Array<{ type: string; source: string }> = [];
			const fakeSession = {
				prompt: async (
					_text: string,
					_images: Array<{ type: "image"; data: string; mimeType: string }> | undefined,
					options?: {
						onTextBlock?: (text: string) => void;
						onEvent?: (event: { type: string; source: string }) => void;
					},
				) => {
					options?.onEvent?.({ type: "message_end", source: "pi" });
					options?.onTextBlock?.("hello from event stream");
					return "hello from event stream";
				},
				getContextUsage: () => null,
			};
			const testRunner = new Runner({ dataDir: testDir });
			(
				testRunner as unknown as {
					createSession(): Promise<typeof fakeSession>;
				}
			).createSession = async () => fakeSession;

			const result = await testRunner.process(
				{
					id: "msg-3",
					chatId: "chat-1",
					senderId: "user-1",
					text: "stream it",
					isGroup: false,
					provider: "telegram",
					timestamp: new Date("2026-04-02T15:02:00Z"),
					raw: {},
				},
				{
					contextKey: "telegram:contact:user-1",
					agentConfig: {
						model: "anthropic/claude-sonnet-4-20250514",
						workspace: join(testDir, "agents", "main"),
						skills: [],
					},
				},
				{
					onTextBlock: (text) => seenTexts.push(text),
					onEvent: (event) => seenEvents.push(event),
				},
			);

			expect(result.response).toBe("hello from event stream");
			expect(seenTexts).toEqual(["hello from event stream"]);
			expect(seenEvents).toEqual([{ type: "message_end", source: "pi" }]);
		});
	});

	describe("runtime error recovery", () => {
		test("classifies unsupported image errors as retryable with hidden note", () => {
			const error = new Error(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.228.content.1.image.source.base64.media_type: Input should be \'image/jpeg\', \'image/png\', \'image/gif\' or \'image/webp\'"}}',
			);

			expect(
				classifyRuntimeError(error, [{ type: "image", data: "x", mimeType: "image/heic" }]),
			).toEqual({
				kind: "retry-with-runtime-note",
				dropImages: true,
				additionalGuidance:
					"The retry is being sent without the attached images because the previous attempt failed while processing them.",
			});
		});

		test("classifies auth errors as user-facing fallback", () => {
			expect(classifyRuntimeError(new Error("No API key found for fireworks-ai."), [])).toEqual({
				kind: "user-facing-fallback",
				userMessage:
					"I hit an upstream authentication/configuration problem and can't answer right now. Please try again later.",
			});
		});

		test("classifies quota errors as user-facing fallback", () => {
			expect(classifyRuntimeError(new Error("insufficient credits"), [])).toEqual({
				kind: "user-facing-fallback",
				userMessage:
					"The upstream AI provider is currently rate-limited or out of quota, so I can't answer right now. Please try again later.",
			});
		});

		test("classifies outages as user-facing fallback", () => {
			expect(classifyRuntimeError(new Error("503 Service Unavailable"), [])).toEqual({
				kind: "user-facing-fallback",
				userMessage:
					"The upstream AI provider is temporarily unavailable, so I can't answer right now. Please try again in a bit.",
			});
		});

		test("leaves unknown errors alone", () => {
			expect(classifyRuntimeError(new Error("weird unknown thing"), [])).toEqual({
				kind: "rethrow",
			});
		});

		test("builds a hidden runtime system prompt", () => {
			const prompt = buildRuntimeErrorSystemPrompt(
				"base prompt",
				"unsupported image format",
				"Retrying without images.",
			);
			expect(prompt).toContain("base prompt");
			expect(prompt).toContain("unsupported image format");
			expect(prompt).toContain("This note is from the runtime and is not visible to the user");
			expect(prompt).toContain("Retrying without images.");
		});

		test("keeps known image mime type when fetch only reports octet-stream", () => {
			expect(resolveFetchedImageMimeType("image/jpeg", "application/octet-stream")).toBe(
				"image/jpeg",
			);
		});

		test("uses fetched content type when it is a supported image mime", () => {
			expect(resolveFetchedImageMimeType("image/jpeg", "image/webp; charset=binary")).toBe(
				"image/webp",
			);
			expect(resolveFetchedImageMimeType(undefined, "image/png")).toBe("image/png");
		});

		test("finds the branch point before a failed user image turn", () => {
			const branchEntries: Parameters<typeof findRetryBranchParentId>[0] = [
				{
					type: "message",
					id: "assistant-ok",
					parentId: null,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						stopReason: "stop",
					},
				},
				{
					type: "message",
					id: "user-image",
					parentId: "assistant-ok",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "what is this?" },
							{ type: "image", mimeType: "application/octet-stream", data: "..." },
						],
					},
				},
				{
					type: "message",
					id: "assistant-error",
					parentId: "user-image",
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "invalid_request_error: unsupported image mime",
					},
				},
			];
			expect(findRetryBranchParentId(branchEntries)).toBe("assistant-ok");
		});

		test("returns null branch point when the failed turn started at the root", () => {
			const branchEntries: Parameters<typeof findRetryBranchParentId>[0] = [
				{
					type: "message",
					id: "user-image",
					parentId: null,
					message: {
						role: "user",
						content: [{ type: "image", mimeType: "application/octet-stream", data: "..." }],
					},
				},
				{
					type: "message",
					id: "assistant-error",
					parentId: "user-image",
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "bad image",
					},
				},
			];
			expect(findRetryBranchParentId(branchEntries)).toBeNull();
		});

		test("user-facing errors preserve a direct fallback message", () => {
			const err = new UserFacingError("upstream auth failed", "human readable fallback");
			expect(err.userMessage).toBe("human readable fallback");
		});
	});

	describe("parseModelString", () => {
		test("keeps nested slashes inside model id", () => {
			expect(parseModelString("fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo")).toEqual([
				"fireworks-ai",
				"accounts/fireworks/routers/kimi-k2p5-turbo",
			]);
		});

		test("defaults to anthropic when provider prefix is missing", () => {
			expect(parseModelString("claude-opus-4-6")).toEqual(["anthropic", "claude-opus-4-6"]);
		});
	});
});
