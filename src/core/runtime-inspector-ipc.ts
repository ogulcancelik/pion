import { existsSync, rmSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import type { RuntimeInspectorSnapshot } from "./runtime-inspector.js";
import { type RuntimeInspectorStore, runtimeInspectorSocketFileFor } from "./runtime-inspector.js";

interface SnapshotEnvelope {
	type: "snapshot";
	snapshot: RuntimeInspectorSnapshot;
}

function encodeSnapshot(snapshot: RuntimeInspectorSnapshot): string {
	const envelope: SnapshotEnvelope = { type: "snapshot", snapshot };
	return `${JSON.stringify(envelope)}\n`;
}

export class RuntimeInspectorServer {
	private server?: Server;
	private clients = new Set<Socket>();
	private unsubscribe?: () => void;
	private socketFile: string;

	constructor(
		private store: RuntimeInspectorStore,
		dataDir: string,
	) {
		this.socketFile = runtimeInspectorSocketFileFor(dataDir);
	}

	async start(): Promise<void> {
		if (existsSync(this.socketFile)) {
			rmSync(this.socketFile, { force: true });
		}

		this.server = createServer((socket) => {
			this.clients.add(socket);
			socket.write(encodeSnapshot(this.store.getSnapshot()));
			socket.on("close", () => {
				this.clients.delete(socket);
			});
		});

		this.unsubscribe = this.store.subscribe((snapshot) => {
			const payload = encodeSnapshot(snapshot);
			for (const client of this.clients) {
				client.write(payload);
			}
		});

		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.socketFile, () => resolve());
		});
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;

		for (const client of this.clients) {
			client.destroy();
		}
		this.clients.clear();

		if (this.server) {
			await new Promise<void>((resolve) => this.server?.close(() => resolve()));
			this.server = undefined;
		}

		if (existsSync(this.socketFile)) {
			rmSync(this.socketFile, { force: true });
		}
	}
}

export class RuntimeInspectorClient {
	private socket?: Socket;
	private listeners = new Set<(snapshot: RuntimeInspectorSnapshot) => void>();
	private buffer = "";
	private socketFile: string;

	constructor(dataDir: string) {
		this.socketFile = runtimeInspectorSocketFileFor(dataDir);
	}

	async connect(): Promise<RuntimeInspectorSnapshot> {
		return await new Promise<RuntimeInspectorSnapshot>((resolve, reject) => {
			const socket = createConnection(this.socketFile);
			this.socket = socket;
			let firstSnapshotResolved = false;

			socket.on("data", (chunk) => {
				this.buffer += chunk.toString();
				const lines = this.buffer.split("\n");
				this.buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					const envelope = JSON.parse(line) as SnapshotEnvelope;
					if (envelope.type !== "snapshot") continue;
					if (!firstSnapshotResolved) {
						firstSnapshotResolved = true;
						resolve(envelope.snapshot);
						continue;
					}
					for (const listener of this.listeners) {
						listener(envelope.snapshot);
					}
				}
			});

			socket.once("error", reject);
		});
	}

	subscribe(listener: (snapshot: RuntimeInspectorSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async close(): Promise<void> {
		if (!this.socket) return;
		await new Promise<void>((resolve) => {
			this.socket?.end(() => resolve());
		});
		this.socket = undefined;
	}
}
