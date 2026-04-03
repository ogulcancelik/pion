import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActiveContextSnapshot, DaemonRuntimeState } from "../../src/core/runtime-state.js";

describe("DaemonRuntimeState", () => {
	function makeTempDir(): string {
		return mkdtempSync(join(tmpdir(), "pion-runtime-state-"));
	}

	function makeContext(overrides: Partial<ActiveContextSnapshot> = {}): ActiveContextSnapshot {
		return {
			contextKey: "telegram:contact:123",
			provider: "telegram",
			chatId: "123",
			startedAt: "2026-03-21T12:00:00.000Z",
			messageId: "msg-1",
			messagePreview: "hello there",
			...overrides,
		};
	}

	test("marks startup dirty and graceful shutdown clean", () => {
		const dataDir = makeTempDir();
		try {
			const state = new DaemonRuntimeState(dataDir);
			const recovery = state.markStartup();

			expect(recovery.recovered).toBe(false);
			expect(existsSync(state.stateFile)).toBe(true);

			let persisted = JSON.parse(readFileSync(state.stateFile, "utf-8"));
			expect(persisted.cleanShutdown).toBe(false);
			expect(persisted.activeContexts).toEqual([]);

			state.markShutdown();

			persisted = JSON.parse(readFileSync(state.stateFile, "utf-8"));
			expect(persisted.cleanShutdown).toBe(true);
			expect(persisted.lastShutdownAt).toBeString();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("returns interrupted contexts after unclean shutdown", () => {
		const dataDir = makeTempDir();
		try {
			const firstRun = new DaemonRuntimeState(dataDir);
			firstRun.markStartup();
			firstRun.trackContextStart(makeContext());
			firstRun.trackContextStart(
				makeContext({
					contextKey: "telegram:chat:abc",
					provider: "telegram",
					chatId: "abc",
				}),
			);

			const secondRun = new DaemonRuntimeState(dataDir);
			const recovery = secondRun.markStartup();

			expect(recovery.recovered).toBe(true);
			expect(recovery.interruptedContexts).toHaveLength(2);
			expect(recovery.previousState?.cleanShutdown).toBe(false);

			const persisted = JSON.parse(readFileSync(secondRun.stateFile, "utf-8"));
			expect(persisted.cleanShutdown).toBe(false);
			expect(persisted.activeContexts).toEqual([]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("tracks and clears active contexts durably", () => {
		const dataDir = makeTempDir();
		try {
			const state = new DaemonRuntimeState(dataDir);
			state.markStartup();
			state.trackContextStart(makeContext());

			let persisted = JSON.parse(readFileSync(state.stateFile, "utf-8"));
			expect(persisted.activeContexts).toHaveLength(1);
			expect(persisted.activeContexts[0].messagePreview).toBe("hello there");

			state.trackContextFinish("telegram:contact:123");

			persisted = JSON.parse(readFileSync(state.stateFile, "utf-8"));
			expect(persisted.activeContexts).toEqual([]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("records last fatal error when available", () => {
		const dataDir = makeTempDir();
		try {
			const state = new DaemonRuntimeState(dataDir);
			state.markStartup();
			state.recordFatalError(new Error("boom"));

			const persisted = JSON.parse(readFileSync(state.stateFile, "utf-8"));
			expect(persisted.lastFatalError).toContain("boom");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
