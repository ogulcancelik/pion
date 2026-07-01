import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@sinclair/typebox";
import {
	PION_MCP_TOOL_PREFIX,
	createPionMcpServer,
	stripPionToolPrefix,
} from "../../src/core/claude-tool-bridge.js";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo the input back.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `echo: ${(params as { value: string }).value}` }],
				details: {},
			};
		},
		...overrides,
	} as ToolDefinition;
}

async function connectClient(tools: ToolDefinition[]): Promise<Client> {
	const serverConfig = createPionMcpServer(tools);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await serverConfig.instance.connect(serverTransport);
	await client.connect(clientTransport);
	return client;
}

describe("createPionMcpServer", () => {
	test("lists pi tools with their TypeBox schema as JSON schema", async () => {
		const client = await connectClient([makeTool()]);
		const result = await client.listTools();

		expect(result.tools).toHaveLength(1);
		const tool = result.tools[0];
		expect(tool?.name).toBe("echo");
		expect(tool?.description).toBe("Echo the input back.");
		expect(tool?.inputSchema.type).toBe("object");
		expect(tool?.inputSchema.properties).toHaveProperty("value");
	});

	test("folds promptGuidelines into the description", async () => {
		const client = await connectClient([
			makeTool({ promptGuidelines: ["Use sparingly.", "One fact per call."] }),
		]);
		const result = await client.listTools();
		expect(result.tools[0]?.description).toContain("- Use sparingly.");
		expect(result.tools[0]?.description).toContain("- One fact per call.");
	});

	test("executes the pi tool and returns its content", async () => {
		const client = await connectClient([makeTool()]);
		const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });

		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
	});

	test("applies prepareArguments before execution", async () => {
		const client = await connectClient([
			makeTool({
				prepareArguments: (args) => ({ value: String((args as { value: unknown }).value) }),
			}),
		]);
		const result = await client.callTool({ name: "echo", arguments: { value: 42 } });
		expect(result.content).toEqual([{ type: "text", text: "echo: 42" }]);
	});

	test("maps thrown errors to isError results", async () => {
		const client = await connectClient([
			makeTool({
				async execute() {
					throw new Error("boom");
				},
			}),
		]);
		const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "boom" }]);
	});
});

describe("stripPionToolPrefix", () => {
	test("strips the mcp server prefix", () => {
		expect(stripPionToolPrefix(`${PION_MCP_TOOL_PREFIX}remember`)).toBe("remember");
	});

	test("leaves native tool names alone", () => {
		expect(stripPionToolPrefix("Bash")).toBe("Bash");
	});
});
