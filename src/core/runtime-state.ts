import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderType } from "../providers/types.js";

export interface ActiveContextSnapshot {
	contextKey: string;
	provider: ProviderType;
	chatId: string;
	startedAt: string;
	messageId?: string;
	messagePreview?: string;
}

export interface PersistedDaemonState {
	version: 1;
	startedAt: string;
	lastHeartbeatAt: string;
	cleanShutdown: boolean;
	lastShutdownAt?: string;
	lastFatalError?: string;
	activeContexts: ActiveContextSnapshot[];
}

export interface StartupRecoveryInfo {
	recovered: boolean;
	interruptedContexts: ActiveContextSnapshot[];
	previousState?: PersistedDaemonState;
}

function nowIso(): string {
	return new Date().toISOString();
}

function defaultState(): PersistedDaemonState {
	const now = nowIso();
	return {
		version: 1,
		startedAt: now,
		lastHeartbeatAt: now,
		cleanShutdown: false,
		activeContexts: [],
	};
}

export class DaemonRuntimeState {
	readonly runtimeDir: string;
	readonly stateFile: string;

	constructor(dataDir: string) {
		this.runtimeDir = join(dataDir, "runtime");
		this.stateFile = join(this.runtimeDir, "daemon-state.json");
	}

	markStartup(): StartupRecoveryInfo {
		const previousState = this.readState();
		const recovered = !!previousState && previousState.cleanShutdown === false;
		const interruptedContexts = recovered ? previousState.activeContexts : [];

		const nextState = defaultState();
		nextState.lastFatalError = previousState?.lastFatalError;
		this.writeState(nextState);

		return { recovered, interruptedContexts, previousState };
	}

	markShutdown(): void {
		const state = this.readState() ?? defaultState();
		state.cleanShutdown = true;
		state.lastShutdownAt = nowIso();
		state.lastHeartbeatAt = state.lastShutdownAt;
		state.activeContexts = [];
		this.writeState(state);
	}

	trackContextStart(snapshot: ActiveContextSnapshot): void {
		const state = this.readState() ?? defaultState();
		state.cleanShutdown = false;
		state.lastHeartbeatAt = nowIso();
		state.activeContexts = [
			...state.activeContexts.filter((ctx) => ctx.contextKey !== snapshot.contextKey),
			snapshot,
		];
		this.writeState(state);
	}

	trackContextFinish(contextKey: string): void {
		const state = this.readState() ?? defaultState();
		state.lastHeartbeatAt = nowIso();
		state.activeContexts = state.activeContexts.filter((ctx) => ctx.contextKey !== contextKey);
		this.writeState(state);
	}

	recordFatalError(error: unknown): void {
		const state = this.readState() ?? defaultState();
		state.lastHeartbeatAt = nowIso();
		state.lastFatalError = this.formatError(error);
		this.writeState(state);
	}

	private ensureRuntimeDir(): void {
		if (!existsSync(this.runtimeDir)) {
			mkdirSync(this.runtimeDir, { recursive: true });
		}
	}

	private readState(): PersistedDaemonState | undefined {
		if (!existsSync(this.stateFile)) {
			return undefined;
		}

		try {
			const raw = JSON.parse(
				readFileSync(this.stateFile, "utf-8"),
			) as Partial<PersistedDaemonState>;
			if (!raw || typeof raw !== "object") return undefined;

			return {
				version: 1,
				startedAt: raw.startedAt || nowIso(),
				lastHeartbeatAt: raw.lastHeartbeatAt || raw.startedAt || nowIso(),
				cleanShutdown: raw.cleanShutdown ?? false,
				lastShutdownAt: raw.lastShutdownAt,
				lastFatalError: raw.lastFatalError,
				activeContexts: Array.isArray(raw.activeContexts) ? raw.activeContexts : [],
			};
		} catch {
			return undefined;
		}
	}

	private writeState(state: PersistedDaemonState): void {
		this.ensureRuntimeDir();
		writeFileSync(this.stateFile, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
	}

	private formatError(error: unknown): string {
		if (error instanceof Error) {
			return error.stack || error.message;
		}
		if (typeof error === "string") {
			return error;
		}
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}
}
