/**
 * Anthropic Claude API wrapper with prompt caching and retry logic
 */

import Anthropic from '@anthropic-ai/sdk';
import { ComplexityLevel, ModelConfig, UsageStats, Logger, AnthropicTool } from './types';
import { MODEL_CONFIG } from './config';

/**
 * Anthropic Client Wrapper
 * Handles Claude API calls with caching, retry logic, and model selection
 */
export class AnthropicClient {
  private client: Anthropic;
  private logger: Logger;
  private systemMessage: string;
  private maxRetries: number = 3;

  constructor(apiKey: string, systemMessage: string, logger: Logger) {
    this.client = new Anthropic({ apiKey });
    this.systemMessage = systemMessage;
    this.logger = logger;
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

      // Build the request parameters
      const params: any = {
        model: modelConfig.model,
        max_tokens: modelConfig.max_tokens,
        system: [
          {
            type: 'text',
            text: this.systemMessage,
            cache_control: { type: 'ephemeral' },
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

        this.logger.info('Claude API response received', {
          model: modelConfig.model,
          stopReason: response.stop_reason,
          usage: response.usage,
          cacheHitRate: `${cacheHitRate.toFixed(2)}%`,
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
   */
  extractUsageStats(response: Anthropic.Message): UsageStats {
    const usage = response.usage as any;
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
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
