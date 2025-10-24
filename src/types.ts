/**
 * Type definitions for DANI Agent Service
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * Complexity levels for determining which Claude model to use
 */
export type ComplexityLevel = 'SIMPLE' | 'PROCEDURAL' | 'ANALYTICAL';

/**
 * HTTP API Request body for /chat endpoint
 */
export interface ChatRequest {
  message: string;
  conversationId?: string;
  complexity?: ComplexityLevel;
}

/**
 * Token usage statistics from Claude API
 */
export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/**
 * HTTP API Response body for /chat endpoint
 */
export interface ChatResponse {
  response: string;
  conversationId: string;
  model: string;
  usage: UsageStats;
}

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: string;
  message: string;
  conversationId?: string;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  mcp_servers: {
    [serverName: string]: 'connected' | 'disconnected' | 'error';
  };
  uptime: number;
  timestamp: string;
}

/**
 * Model configuration for different complexity levels
 */
export interface ModelConfig {
  model: string;
  max_tokens: number;
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
}

/**
 * Complete model configuration mapping
 */
export interface ModelConfigMap {
  SIMPLE: ModelConfig;
  PROCEDURAL: ModelConfig;
  ANALYTICAL: ModelConfig;
}

/**
 * Conversation history stored in memory
 */
export interface Conversation {
  id: string;
  messages: Anthropic.MessageParam[];
  createdAt: Date;
  lastAccessedAt: Date;
  model?: string;
}

/**
 * MCP Tool definition (from MCP server)
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Anthropic tool definition (converted from MCP)
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  cache_control?: {
    type: 'ephemeral';
  };
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  name: string;
  url: string;
}

/**
 * MCP Server connection status
 */
export interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: MCPTool[];
  error?: string;
}

/**
 * Tool execution request
 */
export interface ToolExecutionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  tool_use_id: string;
  type: 'tool_result';
  content: string;
  is_error?: boolean;
}

/**
 * Agent response with tool usage
 */
export interface AgentResponse {
  response: string;
  conversationId: string;
  model: string;
  usage: UsageStats;
  toolsUsed?: string[];
  thinking?: string;
}

/**
 * Logger interface
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Application configuration
 */
export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  anthropicApiKey: string;
  mcpServers: MCPServerConfig[];
  systemMessage: string;
  maxConversationHistory: number;
  conversationTimeoutMinutes: number;
}
