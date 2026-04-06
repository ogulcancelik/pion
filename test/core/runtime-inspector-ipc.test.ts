import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RuntimeInspectorClient,
	RuntimeInspectorServer,
} from "../../src/core/runtime-inspector-ipc.js";
import { RuntimeInspectorStore } from "../../src/core/runtime-inspector.js";

const cleanupDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pion-runtime-inspector-ipc-"));
	cleanupDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("RuntimeInspector IPC", () => {
	test("sends the current snapshot to new clients and pushes later updates", async () => {
		const dataDir = makeTempDir();
		const store = new RuntimeInspectorStore(dataDir);
		store.registerContext({
			agentName: "main",
			contextKey: "telegram:contact:user-1",
			provider: "telegram",
			chatId: "chat-1",
		});

		const server = new RuntimeInspectorServer(store, dataDir);
		await server.start();

		try {
			const client = new RuntimeInspectorClient(dataDir);
			const firstSnapshot = await client.connect();
			expect(firstSnapshot.contexts).toHaveLength(1);
			expect(firstSnapshot.contexts[0]?.agentName).toBe("main");

			const nextSnapshotPromise = new Promise<string>((resolve) => {
				const unsubscribe = client.subscribe((snapshot) => {
					unsubscribe();
					resolve(snapshot.contexts[0]?.status ?? "unknown");
				});
			});

			store.handleRuntimeEvent({
				id: "evt-buffered",
				timestamp: "2026-04-06T12:00:00.000Z",
				source: "pion",
				contextKey: "telegram:contact:user-1",
				type: "runtime_message_buffered",
				messageCount: 1,
			});

			expect(await nextSnapshotPromise).toBe("buffered");
			await client.close();
		} finally {
			await server.stop();
		}
	});
});
