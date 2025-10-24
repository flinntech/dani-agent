/**
 * MCP (Model Context Protocol) Client for connecting to MCP servers
 * and managing tool discovery and execution
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  MCPTool,
  MCPServerConfig,
  MCPServerStatus,
  AnthropicTool,
  Logger,
} from './types';

/**
 * MCP Client Manager
 * Handles connections to multiple MCP servers, tool discovery, and execution
 */
export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private toolToServerMap: Map<string, string> = new Map();
  private serverStatuses: Map<string, MCPServerStatus> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize connections to all configured MCP servers
   */
  async initialize(serverConfigs: MCPServerConfig[]): Promise<void> {
    this.logger.info('Initializing MCP client connections', {
      serverCount: serverConfigs.length,
      servers: serverConfigs.map(s => s.name),
    });

    const initPromises = serverConfigs.map(config => this.connectToServer(config));
    await Promise.allSettled(initPromises);

    // Log final status
    const connectedServers = Array.from(this.serverStatuses.values())
      .filter(s => s.connected)
      .map(s => s.name);

    this.logger.info('MCP initialization complete', {
      connected: connectedServers,
      totalTools: this.toolToServerMap.size,
    });
  }

  /**
   * Connect to a single MCP server and fetch its tools
   */
  private async connectToServer(config: MCPServerConfig): Promise<void> {
    try {
      this.logger.info(`Connecting to MCP server: ${config.name}`, { url: config.url });

      // Create HTTP transport using StreamableHTTP
      const transport = new StreamableHTTPClientTransport(new URL(config.url));

      // Create MCP client
      const client = new Client(
        {
          name: 'dani-agent',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Connect to the server
      await client.connect(transport);

      // Store the client
      this.clients.set(config.name, client);

      // Fetch available tools
      const toolsResult = await client.listTools();
      const tools: MCPTool[] = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      // Map tool names to server
      tools.forEach(tool => {
        this.toolToServerMap.set(tool.name, config.name);
      });

      // Update status
      this.serverStatuses.set(config.name, {
        name: config.name,
        connected: true,
        tools,
      });

      this.logger.info(`Connected to MCP server: ${config.name}`, {
        toolCount: tools.length,
        tools: tools.map(t => t.name),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to connect to MCP server: ${config.name}`, {
        error: errorMessage,
        url: config.url,
      });

      // Update status with error
      this.serverStatuses.set(config.name, {
        name: config.name,
        connected: false,
        tools: [],
        error: errorMessage,
      });
    }
  }

  /**
   * Get all available tools from all connected MCP servers
   * in Anthropic tool format
   */
  getAnthropicTools(): AnthropicTool[] {
    const tools: AnthropicTool[] = [];

    for (const status of this.serverStatuses.values()) {
      if (!status.connected) continue;

      for (const mcpTool of status.tools) {
        tools.push({
          name: mcpTool.name,
          description: mcpTool.description || `Tool: ${mcpTool.name}`,
          input_schema: {
            type: 'object',
            properties: mcpTool.inputSchema.properties || {},
            required: mcpTool.inputSchema.required,
          },
        });
      }
    }

    // Add cache control to the last tool for prompt caching
    if (tools.length > 0) {
      tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    }

    return tools;
  }

  /**
   * Execute a tool call on the appropriate MCP server
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const serverName = this.toolToServerMap.get(toolName);

    if (!serverName) {
      this.logger.error(`Tool not found: ${toolName}`, { availableTools: Array.from(this.toolToServerMap.keys()) });
      return {
        content: `Error: Tool "${toolName}" not found`,
        isError: true,
      };
    }

    const client = this.clients.get(serverName);
    if (!client) {
      this.logger.error(`MCP client not found for server: ${serverName}`);
      return {
        content: `Error: MCP server "${serverName}" not connected`,
        isError: true,
      };
    }

    try {
      this.logger.info(`Executing tool: ${toolName}`, {
        server: serverName,
        arguments: args,
      });

      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      // Extract content from result
      const resultContent: any = result.content;
      const content = Array.isArray(resultContent)
        ? resultContent
            .map((item: any) => {
              if (item.type === 'text') {
                return item.text;
              }
              return JSON.stringify(item);
            })
            .join('\n')
        : String(resultContent);

      this.logger.info(`Tool execution completed: ${toolName}`, {
        server: serverName,
        isError: result.isError === true,
      });

      return {
        content,
        isError: result.isError === true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool execution failed: ${toolName}`, {
        server: serverName,
        error: errorMessage,
      });

      return {
        content: `Error executing tool "${toolName}": ${errorMessage}`,
        isError: true,
      };
    }
  }

  /**
   * Get the status of all MCP servers
   */
  getServerStatuses(): Map<string, MCPServerStatus> {
    return this.serverStatuses;
  }

  /**
   * Close all MCP client connections
   */
  async close(): Promise<void> {
    this.logger.info('Closing all MCP client connections');

    const closePromises = Array.from(this.clients.entries()).map(async ([name, client]) => {
      try {
        await client.close();
        this.logger.info(`Closed connection to MCP server: ${name}`);
      } catch (error) {
        this.logger.error(`Error closing MCP server connection: ${name}`, { error });
      }
    });

    await Promise.allSettled(closePromises);
    this.clients.clear();
    this.toolToServerMap.clear();
  }
}
