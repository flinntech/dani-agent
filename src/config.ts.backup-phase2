/**
 * Configuration management with AWS Secrets Manager integration
 *
 * This is an updated version of config.ts that loads secrets from AWS Secrets Manager
 * when running in production (AWS ECS). Falls back to environment variables for local development.
 *
 * MIGRATION INSTRUCTIONS:
 * 1. Install AWS SDK: npm install @aws-sdk/client-secrets-manager
 * 2. Backup current config.ts: cp src/config.ts src/config.ts.backup
 * 3. Replace config.ts with this file: cp src/config-with-secrets.ts src/config.ts
 * 4. Update package.json dependencies (see instructions below)
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { AppConfig, MCPServerConfig, Logger } from './types';

// Load environment variables from .env file (for local development)
dotenvConfig();

// Configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'dani/prod';
const USE_SECRETS_MANAGER = process.env.USE_SECRETS_MANAGER !== 'false'; // Default to true in production

// In-memory cache of loaded secrets
let secretsCache: Record<string, string> | null = null;

/**
 * Check if running in AWS ECS
 */
function isRunningInAWS(): boolean {
  return !!(
    process.env.ECS_CONTAINER_METADATA_URI ||
    process.env.ECS_CONTAINER_METADATA_URI_V4 ||
    process.env.AWS_EXECUTION_ENV
  );
}

/**
 * Load a single secret from AWS Secrets Manager
 */
async function loadSecret(client: SecretsManagerClient, secretName: string): Promise<string | null> {
  try {
    const command = new GetSecretValueCommand({
      SecretId: secretName,
    });

    const response = await client.send(command);
    return response.SecretString || null;
  } catch (error: any) {
    // Secret not found is OK (will fall back to env var)
    if (error.name === 'ResourceNotFoundException') {
      return null;
    }
    console.error(`[Secrets] Error loading ${secretName}:`, error.message);
    return null;
  }
}

/**
 * Load all secrets from AWS Secrets Manager
 */
async function loadSecrets(): Promise<Record<string, string>> {
  // Return cached secrets if already loaded
  if (secretsCache) {
    return secretsCache;
  }

  const secrets: Record<string, string> = {};

  // Check if we should use Secrets Manager
  const shouldUseSecretsManager = USE_SECRETS_MANAGER && isRunningInAWS();

  if (!shouldUseSecretsManager) {
    console.log('[Secrets] Using environment variables (local development mode)');
    return secrets; // Return empty, will fall back to process.env
  }

  console.log(`[Secrets] Loading secrets from AWS Secrets Manager (region: ${AWS_REGION})`);

  try {
    const client = new SecretsManagerClient({ region: AWS_REGION });

    // Define secrets to load
    const secretMappings: Record<string, string> = {
      ANTHROPIC_API_KEY: `${SECRET_PREFIX}/anthropic/api-key`,
      DRM_API_KEY_ID: `${SECRET_PREFIX}/drm/api-key-id`,
      DRM_API_KEY_SECRET: `${SECRET_PREFIX}/drm/api-key-secret`,
    };

    // Load all secrets in parallel
    await Promise.all(
      Object.entries(secretMappings).map(async ([envVar, secretName]) => {
        const value = await loadSecret(client, secretName);
        if (value) {
          secrets[envVar] = value;
          console.log(`[Secrets] ✓ Loaded: ${envVar}`);
        } else {
          console.warn(`[Secrets] ⚠ Not found: ${envVar} (will use env var if set)`);
        }
      })
    );

    console.log(`[Secrets] Loaded ${Object.keys(secrets).length} secrets from Secrets Manager`);
  } catch (error: any) {
    console.error('[Secrets] Error loading secrets:', error.message);
    console.warn('[Secrets] Falling back to environment variables');
  }

  secretsCache = secrets;
  return secrets;
}

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
 * Create Winston logger instance with file and console transports
 * Enhanced with ECS task ID and container name for better debugging
 */
export function createLogger(config: AppConfig): Logger {
  // Get ECS metadata for context
  const ecsTaskId = process.env.ECS_CONTAINER_METADATA_URI_V4?.match(/\/v4\/([^/]+)/)?.[1];
  const containerName = process.env.ECS_CONTAINER_NAME;
  const taskDefinition = process.env.ECS_TASK_DEFINITION;

  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  );

  // Add ECS metadata to all logs
  const ecsMetadataFormat = winston.format((info) => {
    if (ecsTaskId) info.ecs_task_id = ecsTaskId;
    if (containerName) info.container = containerName;
    if (taskDefinition) info.task_definition = taskDefinition;
    return info;
  });

  const consoleFormat = winston.format.combine(
    ecsMetadataFormat(),
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      let metaStr = '';
      if (Object.keys(meta).length > 0) {
        // Remove color codes for cleaner output
        const cleanMeta = { ...meta };
        delete cleanMeta.ecs_task_id;
        delete cleanMeta.container;
        delete cleanMeta.task_definition;

        if (Object.keys(cleanMeta).length > 0) {
          metaStr = ` ${JSON.stringify(cleanMeta)}`;
        }
      }

      // Add ECS context prefix if available
      const ecsPrefix = containerName ? `[${containerName}] ` : '';
      return `${timestamp} ${ecsPrefix}[${level}]: ${message}${metaStr}`;
    })
  );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ];

  // Add file transports if log directory is configured
  const logDir = process.env.LOG_DIR || '/var/log/dani-agent';

  // Combined log file (all levels)
  transports.push(
    new winston.transports.File({
      filename: `${logDir}/combined.log`,
      format: winston.format.combine(ecsMetadataFormat(), logFormat),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true,
    })
  );

  // Error log file (errors only)
  transports.push(
    new winston.transports.File({
      filename: `${logDir}/error.log`,
      level: 'error',
      format: winston.format.combine(ecsMetadataFormat(), logFormat),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true,
    })
  );

  // Agent activity log (info and above, for tool calls and agent decisions)
  transports.push(
    new winston.transports.File({
      filename: `${logDir}/agent-activity.log`,
      level: 'info',
      format: winston.format.combine(ecsMetadataFormat(), logFormat),
      maxsize: 10485760, // 10MB
      maxFiles: 10,
      tailable: true,
    })
  );

  return winston.createLogger({
    level: config.logLevel,
    format: logFormat,
    transports,
  });
}

/**
 * Log startup information about the environment
 */
export function logEnvironmentInfo(logger: Logger): void {
  const ecsTaskId = process.env.ECS_CONTAINER_METADATA_URI_V4?.match(/\/v4\/([^/]+)/)?.[1];
  const containerName = process.env.ECS_CONTAINER_NAME;
  const taskDefinition = process.env.ECS_TASK_DEFINITION;

  logger.info('Environment Information', {
    node_version: process.version,
    platform: process.platform,
    aws_region: AWS_REGION,
    running_in_aws: isRunningInAWS(),
    use_secrets_manager: USE_SECRETS_MANAGER && isRunningInAWS(),
    ecs_task_id: ecsTaskId || 'N/A',
    container_name: containerName || 'N/A',
    task_definition: taskDefinition || 'N/A',
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

// Export async initialization function
// Note: This replaces the synchronous config export
// You'll need to update index.ts to use: const config = await createConfigAsync();
