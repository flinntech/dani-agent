/**
 * Common AI Client Interface
 * Provides a unified interface for both Anthropic and Bedrock clients
 */

import Anthropic from '@anthropic-ai/sdk';
import { ComplexityLevel, UsageStats, AnthropicTool } from './types';

/**
 * Common interface that both AnthropicClient and BedrockClient implement
 */
export interface AIClient {
  sendMessage(
    messages: Anthropic.MessageParam[],
    tools: AnthropicTool[],
    complexity?: ComplexityLevel,
    retryCount?: number
  ): Promise<Anthropic.Message>;

  extractUsageStats(response: Anthropic.Message): UsageStats;
  extractTextContent(response: Anthropic.Message): string;
  extractThinkingContent(response: Anthropic.Message): string | undefined;
  extractToolUses(response: Anthropic.Message): Anthropic.ToolUseBlock[];
  hasToolUse(response: Anthropic.Message): boolean;
}
