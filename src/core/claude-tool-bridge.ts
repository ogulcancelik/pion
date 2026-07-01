/**
 * Bridge pi ToolDefinitions into an in-process MCP server for the Claude
 * Agent SDK.
 *
 * Pion's native tools (telegram, cron, remember, …) are written as pi
 * ToolDefinitions with TypeBox parameter schemas. TypeBox schemas are plain
 * JSON Schema, and pi tool results are already MCP-shaped content arrays, so
 * the bridge registers them on a low-level MCP Server verbatim instead of
 * re-declaring every tool with Zod.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const PION_MCP_SERVER_NAME = "pion";

/**
 * Tool names surface to the model as `mcp__<server>__<name>`.
 * Used to translate bridged tool names in synthesized runtime events back to
 * their pi names so monitor output stays consistent across engines.
 */
export const PION_MCP_TOOL_PREFIX = `mcp__${PION_MCP_SERVER_NAME}__`;

export function stripPionToolPrefix(toolName: string): string {
	return toolName.startsWith(PION_MCP_TOOL_PREFIX)
		? toolName.slice(PION_MCP_TOOL_PREFIX.length)
		: toolName;
}

/** Minimal MCP server config shape accepted by the Agent SDK's mcpServers option. */
export interface PionMcpServerConfig {
	type: "sdk";
	name: string;
	instance: Server;
}

/**
 * Pion tools never read the pi ExtensionContext (they take it to satisfy the
 * interface); a frozen empty stub keeps that contract honest — any future tool
 * that starts dereferencing it fails loudly instead of silently misbehaving.
 */
const EXTENSION_CONTEXT_STUB = Object.freeze({}) as ExtensionContext;

export function createPionMcpServer(tools: ToolDefinition[]): PionMcpServerConfig {
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

	const server = new Server(
		{ name: PION_MCP_SERVER_NAME, version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: Array.from(toolsByName.values()).map((tool) => ({
			name: tool.name,
			description: buildToolDescription(tool),
			// TypeBox schemas are JSON Schema objects.
			inputSchema: tool.parameters as unknown as {
				type: "object";
				properties?: Record<string, unknown>;
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = toolsByName.get(request.params.name);
		if (!tool) {
			return {
				content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
				isError: true,
			};
		}

		const rawArgs = request.params.arguments ?? {};
		const args = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;

		try {
			const result = await tool.execute(
				extra.requestId != null ? String(extra.requestId) : tool.name,
				args,
				extra.signal,
				undefined,
				EXTENSION_CONTEXT_STUB,
			);
			return {
				// pi AgentToolResult content (text/image) is already MCP content.
				content: result.content,
				isError: false,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
			};
		}
	});

	return { type: "sdk", name: PION_MCP_SERVER_NAME, instance: server };
}

function buildToolDescription(tool: ToolDefinition): string {
	if (!tool.promptGuidelines || tool.promptGuidelines.length === 0) {
		return tool.description;
	}
	// pi injects guidelines into its system prompt; over MCP the description is
	// the only channel, so fold them in.
	return `${tool.description}\n\n${tool.promptGuidelines.map((line) => `- ${line}`).join("\n")}`;
}
