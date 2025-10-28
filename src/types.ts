/**
 * Type definitions for DANI Agent Service
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * Complexity levels for determining which Claude model to use
 */
export type ComplexityLevel = 'SIMPLE' | 'PROCEDURAL' | 'ANALYTICAL';

/**
 * DRM API credentials for user-specific access
 */
export interface DrmApiKeys {
  apiKeyId: string;
  apiKeySecret: string;
}

/**
 * HTTP API Request body for /chat endpoint
 */
export interface ChatRequest {
  message: string;
  conversationId?: string;
  complexity?: ComplexityLevel;
  userId?: string;
  drmApiKeys?: DrmApiKeys;
}

/**
 * Token usage statistics from Claude API
 */
export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  // Cache token breakdown by duration (if available)
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_read_5m_tokens?: number;
  cache_read_1h_tokens?: number;
}

/**
 * HTTP API Response body for /chat endpoint
 */
export interface ChatResponse {
  response: string;
  conversationId: string;
  model: string;
  usage: UsageStats;
  iterations?: number;
  toolCallDetails?: ToolCallDetail[];
  reasoningSteps?: ReasoningStep[];
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
  message?: string;  // Optional message for unhealthy status
  task_definition?: string;  // ECS task definition version (for debugging)
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
    ttl?: '5m' | '1h';
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
 * Detailed information about a tool call execution
 */
export interface ToolCallDetail {
  toolName: string;
  server?: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
  duration: number;
  isError: boolean;
  iteration: number;
}

/**
 * Reasoning step in the agentic loop
 */
export interface ReasoningStep {
  iteration: number;
  timestamp: string;
  toolsRequested: string[];
  thinking?: string;
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
  complexityDetected?: ComplexityLevel;
  complexitySource?: 'auto' | 'manual';
  usageBreakdown?: UsageStats[];
  iterations?: number;
  toolCallDetails?: ToolCallDetail[];
  reasoningSteps?: ReasoningStep[];
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
  // Anthropic configuration
  anthropicApiKey?: string;
  // AWS Bedrock configuration
  useBedrock?: boolean;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  // Common configuration
  mcpServers: MCPServerConfig[];
  systemMessage: string;
  conversationTimeoutMinutes: number;
  maxConversationMessages?: number;  // Maximum messages to keep in history (reduces token usage)
  cacheTTL?: '5m' | '1h';
}
