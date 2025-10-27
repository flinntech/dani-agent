/**
 * Anthropic Claude API wrapper with prompt caching and retry logic
 */

import Anthropic from '@anthropic-ai/sdk';
import { ComplexityLevel, ModelConfig, UsageStats, Logger, AnthropicTool } from './types';
import { MODEL_CONFIG } from './config';
import { AIClient } from './ai-client.interface';

/**
 * Anthropic Client Wrapper
 * Handles Claude API calls with caching, retry logic, and model selection
 */
export class AnthropicClient implements AIClient {
  private client: Anthropic;
  private logger: Logger;
  private systemMessage: string;
  private maxRetries: number = 3;
  private cacheTTL?: '5m' | '1h';

  constructor(apiKey: string, systemMessage: string, logger: Logger, cacheTTL?: '5m' | '1h') {
    this.client = new Anthropic({ apiKey });
    this.systemMessage = systemMessage;
    this.logger = logger;
    this.cacheTTL = cacheTTL;
  }

  /**
   * Get model configuration based on complexity level
   */
  private getModelConfig(complexity: ComplexityLevel = 'ANALYTICAL'): ModelConfig {
    return MODEL_CONFIG[complexity];
  }

  /**
   * Sleep for exponential backoff
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Send a message to Claude with retry logic and exponential backoff
   */
  async sendMessage(
    messages: Anthropic.MessageParam[],
    tools: AnthropicTool[],
    complexity: ComplexityLevel = 'ANALYTICAL',
    retryCount: number = 0
  ): Promise<Anthropic.Message> {
    const modelConfig = this.getModelConfig(complexity);

    try {
      this.logger.info('Sending message to Claude', {
        model: modelConfig.model,
        complexity,
        messageCount: messages.length,
        toolCount: tools.length,
        retryCount,
      });

      // Log detailed message content for debugging (at debug level)
      this.logger.debug('Claude API request details', {
        messages: messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === 'string'
            ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '')
            : '[complex content]'
        })),
        toolCount: tools.length,
        toolNames: tools.map(t => t.name),
      });

      // Build the request parameters
      const cacheControl: any = { type: 'ephemeral' };
      if (this.cacheTTL) {
        cacheControl.ttl = this.cacheTTL;
      }

      const params: any = {
        model: modelConfig.model,
        max_tokens: modelConfig.max_tokens,
        system: [
          {
            type: 'text',
            text: this.systemMessage,
            cache_control: cacheControl,
          },
        ],
        messages,
        tools: tools.length > 0 ? tools : undefined,
      };

      // Add thinking configuration for analytical queries
      if (modelConfig.thinking && modelConfig.thinking.type === 'enabled') {
        params.thinking = {
          type: 'enabled',
          budget_tokens: modelConfig.thinking.budget_tokens,
        };
      }

      // Make the API call
      const response = await this.client.messages.create(params) as Anthropic.Message;

      // Log cache performance
      const usage = response.usage as any;
      if (usage) {
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const inputTokens = usage.input_tokens || 0;
        const cacheHitRate = cacheReadTokens > 0
          ? (cacheReadTokens / (inputTokens + cacheReadTokens)) * 100
          : 0;

        // Build cache breakdown info if available from nested objects
        const cacheBreakdown: any = {};
        if (usage.cache_creation?.ephemeral_5m_input_tokens !== undefined) {
          cacheBreakdown.cache_creation_5m = usage.cache_creation.ephemeral_5m_input_tokens;
        }
        if (usage.cache_creation?.ephemeral_1h_input_tokens !== undefined) {
          cacheBreakdown.cache_creation_1h = usage.cache_creation.ephemeral_1h_input_tokens;
        }
        if (usage.cache_read?.ephemeral_5m_input_tokens !== undefined) {
          cacheBreakdown.cache_read_5m = usage.cache_read.ephemeral_5m_input_tokens;
        }
        if (usage.cache_read?.ephemeral_1h_input_tokens !== undefined) {
          cacheBreakdown.cache_read_1h = usage.cache_read.ephemeral_1h_input_tokens;
        }

        this.logger.info('Claude API response received', {
          model: modelConfig.model,
          stopReason: response.stop_reason,
          usage: response.usage,
          cacheHitRate: `${cacheHitRate.toFixed(2)}%`,
          ...(Object.keys(cacheBreakdown).length > 0 && { cacheBreakdown }),
        });

        // Log response content details (at debug level)
        this.logger.debug('Claude API response details', {
          stopReason: response.stop_reason,
          contentBlocks: response.content.map((block: any) => {
            if (block.type === 'text') {
              return {
                type: 'text',
                text: block.text.substring(0, 500) + (block.text.length > 500 ? '...' : '')
              };
            } else if (block.type === 'thinking') {
              return {
                type: 'thinking',
                thinking: block.thinking?.substring(0, 200) + '...'
              };
            } else if (block.type === 'tool_use') {
              return {
                type: 'tool_use',
                name: block.name,
                id: block.id,
                input: JSON.stringify(block.input).substring(0, 200) + '...'
              };
            }
            return { type: block.type };
          })
        });
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Claude API error', {
        error: errorMessage,
        retryCount,
        model: modelConfig.model,
      });

      // Retry with exponential backoff for rate limits and transient errors
      if (retryCount < this.maxRetries) {
        const shouldRetry = this.shouldRetry(error);
        if (shouldRetry) {
          const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          this.logger.warn(`Retrying Claude API call after ${backoffMs}ms`, {
            retryCount: retryCount + 1,
            maxRetries: this.maxRetries,
          });

          await this.sleep(backoffMs);
          return this.sendMessage(messages, tools, complexity, retryCount + 1);
        }
      }

      // Re-throw error if not retryable or max retries exceeded
      throw error;
    }
  }

  /**
   * Determine if an error is retryable
   */
  private shouldRetry(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      // Retry on rate limits and server errors
      const status = error.status;
      return status === 429 || (status !== undefined && status >= 500 && status < 600);
    }
    return false;
  }

  /**
   * Extract usage statistics from Claude response
   *
   * Note: Cache duration breakdown (5m vs 1h tokens) requires the 'extended-cache-ttl-2025-04-11' beta
   * and explicit TTL specification in cache_control. When available, provides granular tracking of
   * cache token durations via usage.cache_creation.ephemeral_5m/1h_input_tokens.
   */
  extractUsageStats(response: Anthropic.Message): UsageStats {
    const usage = response.usage as any;

    // Extract total cache tokens
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    // Extract cache token breakdown by duration from nested objects (if available)
    // These fields only appear when using the extended-cache-ttl beta with explicit TTL values
    const cacheCreation5m = usage.cache_creation?.ephemeral_5m_input_tokens;
    const cacheCreation1h = usage.cache_creation?.ephemeral_1h_input_tokens;
    const cacheRead5m = usage.cache_read?.ephemeral_5m_input_tokens;
    const cacheRead1h = usage.cache_read?.ephemeral_1h_input_tokens;

    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
      ...(cacheCreation5m !== undefined && { cache_creation_5m_tokens: cacheCreation5m }),
      ...(cacheCreation1h !== undefined && { cache_creation_1h_tokens: cacheCreation1h }),
      ...(cacheRead5m !== undefined && { cache_read_5m_tokens: cacheRead5m }),
      ...(cacheRead1h !== undefined && { cache_read_1h_tokens: cacheRead1h }),
    };
  }

  /**
   * Extract text content from Claude response
   */
  extractTextContent(response: Anthropic.Message): string {
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );

    return textBlocks.map(block => block.text).join('\n');
  }

  /**
   * Extract thinking content from Claude response (for analytical mode)
   */
  extractThinkingContent(response: Anthropic.Message): string | undefined {
    const thinkingBlocks = response.content.filter(
      (block: any) => block.type === 'thinking'
    );

    if (thinkingBlocks.length === 0) {
      return undefined;
    }

    return thinkingBlocks.map((block: any) => block.thinking).join('\n');
  }

  /**
   * Extract tool use requests from Claude response
   */
  extractToolUses(response: Anthropic.Message): Anthropic.ToolUseBlock[] {
    return response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
  }

  /**
   * Check if response contains tool use
   */
  hasToolUse(response: Anthropic.Message): boolean {
    return response.stop_reason === 'tool_use' || this.extractToolUses(response).length > 0;
  }
}
