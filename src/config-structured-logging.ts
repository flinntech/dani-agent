/**
 * Configuration management with Structured Logging
 *
 * This is an updated version of config-with-secrets.ts that uses the new
 * structured logger instead of Winston for better CloudWatch debugging.
 *
 * MIGRATION INSTRUCTIONS:
 * 1. Backup current config.ts: cp src/config.ts src/config.ts.backup-winston
 * 2. Replace config.ts with this file: cp src/config-structured-logging.ts src/config.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { AppConfig, MCPServerConfig } from './types';
import { StructuredLogger } from './shared/structured-logger';
import { loadSecrets, isRunningInAWS, getECSTaskId } from './shared/secrets-loader';

// Load environment variables from .env file (for local development)
dotenvConfig();

// Configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'dani/prod';
const USE_SECRETS_MANAGER = process.env.USE_SECRETS_MANAGER !== 'false';

/**
 * Get environment variable with Secrets Manager fallback
 */
function getEnvVar(key: string, secrets: Record<string, string>, defaultValue?: string): string | undefined {
  // Priority: Secrets Manager > Environment Variable > Default
  return secrets[key] || process.env[key] || defaultValue;
}

/**
 * Load system message from environment variable or file
 */
function loadSystemMessage(): string {
  // First try environment variable
  if (process.env.SYSTEM_MESSAGE) {
    return process.env.SYSTEM_MESSAGE;
  }

  // Then try system-message.md file
  const systemMessagePath = join(process.cwd(), 'system-message.md');
  if (existsSync(systemMessagePath)) {
    try {
      return readFileSync(systemMessagePath, 'utf-8').trim();
    } catch (error) {
      console.warn('Failed to read system-message.md, using default', error);
    }
  }

  // Default fallback
  return 'You are a helpful AI assistant.';
}

/**
 * Validate required configuration
 */
function validateConfig(secrets: Record<string, string>): void {
  const useAnthropic = process.env.USE_ANTHROPIC === 'true' || !process.env.USE_BEDROCK;
  const useBedrock = process.env.USE_BEDROCK === 'true';

  if (useAnthropic && !useBedrock) {
    // Anthropic direct API
    const apiKey = getEnvVar('ANTHROPIC_API_KEY', secrets);
    if (!apiKey) {
      throw new Error('Missing ANTHROPIC_API_KEY - not found in Secrets Manager or environment variables');
    }
  } else if (useBedrock) {
    // AWS Bedrock
    if (!process.env.AWS_REGION) {
      throw new Error('Missing AWS_REGION for Bedrock configuration');
    }
  } else {
    throw new Error('Invalid AI provider configuration. Set USE_ANTHROPIC=true or USE_BEDROCK=true');
  }
}

/**
 * Parse MCP server configurations from environment variables
 */
function parseMCPServers(): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [];

  // DRM MCP Server
  if (process.env.DRM_MCP_URL) {
    servers.push({
      name: 'drm',
      url: process.env.DRM_MCP_URL,
    });
  }

  // Outage Monitor MCP Server
  if (process.env.OUTAGE_MCP_URL) {
    servers.push({
      name: 'outage',
      url: process.env.OUTAGE_MCP_URL,
    });
  }

  return servers;
}

/**
 * Create and configure the application configuration with Secrets Manager support
 */
export async function createConfigAsync(): Promise<AppConfig> {
  // Load secrets from AWS Secrets Manager
  const secrets = await loadSecrets();

  // Validate configuration
  validateConfig(secrets);

  // Parse cache TTL configuration
  const cacheTTL = process.env.CACHE_TTL as '5m' | '1h' | undefined;
  if (cacheTTL && cacheTTL !== '5m' && cacheTTL !== '1h') {
    throw new Error('CACHE_TTL must be either "5m" or "1h"');
  }

  const useBedrock = process.env.USE_BEDROCK === 'true';

  return {
    port: parseInt(process.env.PORT || '8080', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    // Anthropic configuration (loaded from Secrets Manager in production)
    anthropicApiKey: getEnvVar('ANTHROPIC_API_KEY', secrets),
    // AWS Bedrock configuration
    useBedrock,
    awsRegion: process.env.AWS_REGION,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    // Common configuration
    mcpServers: parseMCPServers(),
    systemMessage: loadSystemMessage(),
    conversationTimeoutMinutes: parseInt(process.env.CONVERSATION_TIMEOUT_MINUTES || '60', 10),
    maxConversationMessages: process.env.MAX_CONVERSATION_MESSAGES
      ? parseInt(process.env.MAX_CONVERSATION_MESSAGES, 10)
      : 20,
    cacheTTL,
  };
}

/**
 * Create Structured Logger instance
 */
export function createLogger(config: AppConfig): StructuredLogger {
  const logLevel = config.logLevel as 'debug' | 'info' | 'warn' | 'error';
  return new StructuredLogger('dani-agent', logLevel);
}

/**
 * Log startup information about the environment
 */
export function logEnvironmentInfo(logger: StructuredLogger): void {
  const ecsTaskId = getECSTaskId();
  const containerName = process.env.HOSTNAME;
  const taskDefinition = process.env.ECS_TASK_DEFINITION;

  logger.info('DANI Agent starting up', {
    node_version: process.version,
    platform: process.platform,
    aws_region: AWS_REGION,
    running_in_aws: isRunningInAWS(),
    use_secrets_manager: USE_SECRETS_MANAGER && isRunningInAWS(),
    ecsTaskId: ecsTaskId || 'N/A',
    containerName: containerName || 'N/A',
    taskDefinition: taskDefinition || 'N/A',
  });
}

/**
 * Model configuration for different complexity levels
 */
export const MODEL_CONFIG = {
  SIMPLE: {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    thinking: {
      type: 'disabled' as const,
    },
  },
  PROCEDURAL: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16000,
    thinking: {
      type: 'disabled' as const,
    },
  },
  ANALYTICAL: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16000,
    thinking: {
      type: 'enabled' as const,
      budget_tokens: 10000,
    },
  },
} as const;
