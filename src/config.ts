/**
 * Configuration management and environment variable loading
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import { AppConfig, MCPServerConfig, Logger } from './types';

// Load environment variables from .env file
dotenvConfig();

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
 * Validate required environment variables
 */
function validateConfig(): void {
  const required = ['ANTHROPIC_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
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
 * Create and configure the application configuration
 */
export function createConfig(): AppConfig {
  validateConfig();

  return {
    port: parseInt(process.env.PORT || '8080', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    mcpServers: parseMCPServers(),
    systemMessage: loadSystemMessage(),
    maxConversationHistory: parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10),
    conversationTimeoutMinutes: parseInt(process.env.CONVERSATION_TIMEOUT_MINUTES || '60', 10),
  };
}

/**
 * Create Winston logger instance
 */
export function createLogger(config: AppConfig): Logger {
  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  );

  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      let metaStr = '';
      if (Object.keys(meta).length > 0) {
        metaStr = ` ${JSON.stringify(meta)}`;
      }
      return `${timestamp} [${level}]: ${message}${metaStr}`;
    })
  );

  return winston.createLogger({
    level: config.logLevel,
    format: logFormat,
    transports: [
      new winston.transports.Console({
        format: consoleFormat,
      }),
    ],
  });
}

/**
 * Model configuration for different complexity levels
 */
export const MODEL_CONFIG = {
  SIMPLE: {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20000,
    thinking: {
      type: 'disabled' as const,
    },
  },
  PROCEDURAL: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 20000,
    thinking: {
      type: 'disabled' as const,
    },
  },
  ANALYTICAL: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 20000,
    thinking: {
      type: 'enabled' as const,
      budget_tokens: 10000,
    },
  },
} as const;

// Export singleton config instance
export const config = createConfig();
export const logger = createLogger(config);
