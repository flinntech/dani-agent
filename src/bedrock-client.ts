/**
 * AWS Bedrock Claude API wrapper with retry logic
 * Implements the AIClient interface for seamless migration from Anthropic Direct API
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import Anthropic from '@anthropic-ai/sdk';
import { ComplexityLevel, ModelConfig, UsageStats, Logger, AnthropicTool } from './types';
import { MODEL_CONFIG } from './config';
import { AIClient } from './ai-client.interface';

/**
 * Bedrock Client Wrapper
 * Handles Claude API calls through AWS Bedrock with retry logic and model selection
 * Returns Anthropic-compatible types for seamless integration
 */
export class BedrockClient implements AIClient {
  private client: BedrockRuntimeClient;
  private logger: Logger;
  private systemMessage: string;
  private maxRetries: number = 3;

  constructor(
    region: string,
    systemMessage: string,
    logger: Logger,
    accessKeyId?: string,
    secretAccessKey?: string
  ) {
    const credentials = accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : undefined;

    this.client = new BedrockRuntimeClient({
      region,
      credentials,
    });
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
   * Map internal model names to Bedrock model IDs
   */
  private getBedrockModelId(modelName: string): string {
    const modelMap: Record<string, string> = {
      // Claude models
      'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      // Amazon Nova models (already have full IDs, but include for consistency)
      'amazon.nova-micro-v1:0': 'amazon.nova-micro-v1:0',
      'amazon.nova-lite-v1:0': 'amazon.nova-lite-v1:0',
      'amazon.nova-pro-v1:0': 'amazon.nova-pro-v1:0',
    };

    // If already a full model ID, return as-is
    if (modelName.includes('.') && modelName.includes(':')) {
      return modelName;
    }

    return modelMap[modelName] || modelName;
  }

  /**
   * Sleep for exponential backoff
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Convert Bedrock response to Anthropic.Message format
   */
  private convertToAnthropicMessage(bedrockResponse: any, modelName: string, isNovaModel: boolean): Anthropic.Message {
    if (isNovaModel) {
      // Nova response format: { output: { message: { role, content } }, stopReason, usage }
      const outputMessage = bedrockResponse.output?.message || bedrockResponse;

      // Nova content blocks have structure: [{ text: "..." }] without type field
      // Convert to Anthropic format: [{ type: "text", text: "..." }]
      const normalizedContent = (outputMessage.content || []).map((block: any) => {
        if (block.text !== undefined) {
          return {
            type: 'text',
            text: block.text,
          };
        } else if (block.toolUse) {
          // Nova tool use format
          return {
            type: 'tool_use',
            id: block.toolUse.toolUseId,
            name: block.toolUse.name,
            input: block.toolUse.input,
          };
        }
        // Pass through any other block types as-is
        return block;
      });

      return {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: normalizedContent,
        model: modelName,
        stop_reason: bedrockResponse.stopReason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: bedrockResponse.usage?.inputTokens || 0,
          output_tokens: bedrockResponse.usage?.outputTokens || 0,
        },
      };
    } else {
      // Claude response format
      return {
        id: bedrockResponse.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: bedrockResponse.content,
        model: modelName,
        stop_reason: bedrockResponse.stop_reason,
        stop_sequence: bedrockResponse.stop_sequence || null,
        usage: {
          input_tokens: bedrockResponse.usage.input_tokens,
          output_tokens: bedrockResponse.usage.output_tokens,
        },
      };
    }
  }

  /**
   * Send a message to Claude via Bedrock with retry logic and exponential backoff
   * Returns an Anthropic.Message for compatibility
   */
  async sendMessage(
    messages: Anthropic.MessageParam[],
    tools: AnthropicTool[],
    complexity: ComplexityLevel = 'ANALYTICAL',
    retryCount: number = 0
  ): Promise<Anthropic.Message> {
    const modelConfig = this.getModelConfig(complexity);
    const bedrockModelId = this.getBedrockModelId(modelConfig.model);

    try {
      this.logger.info('Sending message to Claude via Bedrock', {
        model: modelConfig.model,
        bedrockModelId,
        complexity,
        messageCount: messages.length,
        toolCount: tools.length,
        retryCount,
      });

      // Log detailed message content for debugging (at debug level)
      this.logger.debug('Bedrock API request details', {
        messages: messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === 'string'
            ? msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : '')
            : '[complex content]'
        })),
        toolCount: tools.length,
        toolNames: tools.map(t => t.name),
      });

      // Detect model family (Nova vs Claude)
      const isNovaModel = bedrockModelId.includes('amazon.nova');

      // Build the request body for Bedrock
      let requestBody: any;

      if (isNovaModel) {
        // Amazon Nova request format
        requestBody = {
          messages: messages.map(msg => ({
            role: msg.role,
            content: typeof msg.content === 'string'
              ? [{ text: msg.content }]
              : msg.content,
          })),
          system: [{ text: this.systemMessage }],
          inferenceConfig: {
            maxTokens: modelConfig.max_tokens,
            temperature: 0.7,
            topP: 0.9,
          },
        };

        // Add tools if provided (Nova only supports "auto" mode)
        if (tools.length > 0) {
          requestBody.toolConfig = {
            tools: tools.map(tool => ({
              toolSpec: {
                name: tool.name,
                description: tool.description,
                inputSchema: {
                  json: tool.input_schema,
                },
              },
            })),
            toolChoice: { auto: {} },
          };
        }

        // Note: Nova doesn't support thinking/extended reasoning in the same way as Claude
      } else {
        // Claude (Anthropic) request format
        requestBody = {
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: modelConfig.max_tokens,
          system: this.systemMessage,
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
        };

        // Add tools if provided
        if (tools.length > 0) {
          requestBody.tools = tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          }));
        }

        // Add thinking configuration for analytical queries
        if (modelConfig.thinking && modelConfig.thinking.type === 'enabled') {
          requestBody.thinking = {
            type: 'enabled',
            budget_tokens: modelConfig.thinking.budget_tokens,
          };
        }
      }

      // Create the Bedrock command
      const command = new InvokeModelCommand({
        modelId: bedrockModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody),
      });

      // Make the API call
      const response = await this.client.send(command);

      // Parse the response
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      // Log raw response for debugging
      this.logger.info('Raw Bedrock response structure', {
        hasOutput: !!responseBody.output,
        hasContent: !!responseBody.content,
        hasMessage: !!(responseBody.output?.message),
        stopReason: responseBody.stopReason || responseBody.stop_reason,
        keys: Object.keys(responseBody),
        messageContent: responseBody.output?.message?.content || responseBody.content,
        fullResponse: JSON.stringify(responseBody).substring(0, 500),
      });

      // Convert Bedrock response to Anthropic format
      const message = this.convertToAnthropicMessage(responseBody, modelConfig.model, isNovaModel);

      this.logger.info('Bedrock API response received', {
        model: modelConfig.model,
        bedrockModelId,
        stopReason: message.stop_reason,
        usage: message.usage,
      });

      // Log response content details (at debug level)
      this.logger.debug('Bedrock API response details', {
        stopReason: message.stop_reason,
        contentBlocks: message.content.map((block: any) => {
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

      return message;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Bedrock API error', {
        error: errorMessage,
        retryCount,
        model: modelConfig.model,
      });

      // Retry with exponential backoff for rate limits and transient errors
      if (retryCount < this.maxRetries) {
        const shouldRetry = this.shouldRetry(error);
        if (shouldRetry) {
          const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          this.logger.warn(`Retrying Bedrock API call after ${backoffMs}ms`, {
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
    if (error instanceof Error) {
      const errorStr = error.message.toLowerCase();
      // Retry on throttling, rate limits, and server errors
      return (
        errorStr.includes('throttling') ||
        errorStr.includes('throttled') ||
        errorStr.includes('rate') ||
        errorStr.includes('429') ||
        errorStr.includes('500') ||
        errorStr.includes('503') ||
        errorStr.includes('serviceexception')
      );
    }
    return false;
  }

  /**
   * Extract usage statistics from response
   * Note: Bedrock does not currently support prompt caching for Claude models,
   * so cache-related tokens will be 0
   */
  extractUsageStats(response: Anthropic.Message): UsageStats {
    return {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };
  }

  /**
   * Extract text content from response
   */
  extractTextContent(response: Anthropic.Message): string {
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );

    return textBlocks.map(block => block.text).join('\n');
  }

  /**
   * Extract thinking content from response (for analytical mode)
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
   * Extract tool use requests from response
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
