/**
 * Core DANI Agent Logic
 * Handles conversation management, agentic loop, and tool execution
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  Conversation,
  ComplexityLevel,
  AgentResponse,
  Logger,
  AppConfig,
} from './types';
import { AnthropicClient } from './anthropic-client';
import { MCPClientManager } from './mcp-client';

/**
 * DANI Agent
 * Main agent class that orchestrates Claude API calls, tool execution, and conversation management
 */
export class DANIAgent {
  private anthropicClient: AnthropicClient;
  private mcpManager: MCPClientManager;
  private logger: Logger;
  private config: AppConfig;
  private conversations: Map<string, Conversation> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    anthropicClient: AnthropicClient,
    mcpManager: MCPClientManager,
    config: AppConfig,
    logger: Logger
  ) {
    this.anthropicClient = anthropicClient;
    this.mcpManager = mcpManager;
    this.config = config;
    this.logger = logger;

    // Start conversation cleanup timer
    this.startConversationCleanup();
  }

  /**
   * Process a user message and return the agent's response
   * This implements the main agentic loop with tool execution
   */
  async processMessage(
    userMessage: string,
    conversationId?: string,
    complexity: ComplexityLevel = 'ANALYTICAL'
  ): Promise<AgentResponse> {
    // Get or create conversation
    const convId = conversationId || uuidv4();
    const conversation = this.getOrCreateConversation(convId);

    this.logger.info('Processing message', {
      conversationId: convId,
      complexity,
      messageLength: userMessage.length,
      historySize: conversation.messages.length,
    });

    try {
      // Add user message to conversation
      conversation.messages.push({
        role: 'user',
        content: userMessage,
      });

      // Execute the agentic loop
      const result = await this.agenticLoop(conversation, complexity);

      // Update conversation metadata
      conversation.lastAccessedAt = new Date();
      conversation.model = result.model;

      // Trim conversation history if needed
      this.trimConversationHistory(conversation);

      return {
        ...result,
        conversationId: convId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Error processing message', {
        conversationId: convId,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Main agentic loop - handles tool use iterations
   * Recursively calls Claude until we get a final response
   */
  private async agenticLoop(
    conversation: Conversation,
    complexity: ComplexityLevel,
    iteration: number = 1
  ): Promise<AgentResponse> {
    const maxIterations = 10; // Prevent infinite loops

    if (iteration > maxIterations) {
      this.logger.warn('Max iterations reached in agentic loop', {
        conversationId: conversation.id,
        iterations: iteration,
      });
      throw new Error('Maximum tool use iterations exceeded');
    }

    this.logger.debug('Agentic loop iteration', {
      conversationId: conversation.id,
      iteration,
      messageCount: conversation.messages.length,
    });

    // Get available tools from MCP servers
    const tools = this.mcpManager.getAnthropicTools();

    // Call Claude API
    const response = await this.anthropicClient.sendMessage(
      conversation.messages,
      tools,
      complexity
    );

    // Check stop reason
    if (this.anthropicClient.hasToolUse(response)) {
      // Extract tool uses
      const toolUses = this.anthropicClient.extractToolUses(response);

      this.logger.info('Claude requested tool use', {
        conversationId: conversation.id,
        iteration,
        toolCount: toolUses.length,
        tools: toolUses.map(t => t.name),
      });

      // Add assistant's response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute all requested tools
      const toolResults = await this.executeTools(toolUses);

      // Add tool results to conversation as user message
      conversation.messages.push({
        role: 'user',
        content: toolResults,
      });

      // Continue the loop with the tool results
      return this.agenticLoop(conversation, complexity, iteration + 1);
    } else {
      // Final response received
      const textContent = this.anthropicClient.extractTextContent(response);
      const thinkingContent = this.anthropicClient.extractThinkingContent(response);
      const usage = this.anthropicClient.extractUsageStats(response);

      this.logger.info('Final response received', {
        conversationId: conversation.id,
        iterations: iteration,
        responseLength: textContent.length,
        hasThinking: !!thinkingContent,
        usage,
      });

      // Add final response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Get model from response
      const modelConfig = response.model;

      return {
        response: textContent,
        conversationId: conversation.id,
        model: modelConfig,
        usage,
        thinking: thinkingContent,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  private async executeTools(
    toolUses: Anthropic.ToolUseBlock[]
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const toolExecutions = toolUses.map(async (toolUse) => {
      const startTime = Date.now();

      try {
        const result = await this.mcpManager.executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>
        );

        const duration = Date.now() - startTime;

        this.logger.info('Tool execution completed', {
          tool: toolUse.name,
          duration: `${duration}ms`,
          isError: result.isError,
        });

        return {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const duration = Date.now() - startTime;

        this.logger.error('Tool execution failed', {
          tool: toolUse.name,
          duration: `${duration}ms`,
          error: errorMessage,
        });

        return {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: `Error: ${errorMessage}`,
          is_error: true,
        };
      }
    });

    return Promise.all(toolExecutions);
  }

  /**
   * Get or create a conversation
   */
  private getOrCreateConversation(conversationId: string): Conversation {
    let conversation = this.conversations.get(conversationId);

    if (!conversation) {
      conversation = {
        id: conversationId,
        messages: [],
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      };
      this.conversations.set(conversationId, conversation);

      this.logger.info('Created new conversation', {
        conversationId,
        totalConversations: this.conversations.size,
      });
    }

    return conversation;
  }

  /**
   * Trim conversation history to stay within limits
   * Ensures tool_use/tool_result pairs are kept together
   */
  private trimConversationHistory(conversation: Conversation): void {
    const maxMessages = this.config.maxConversationHistory;

    if (conversation.messages.length <= maxMessages) {
      return;
    }

    // Find a safe trimming point that doesn't break tool_use/tool_result pairs
    let trimIndex = conversation.messages.length - maxMessages;

    // Check if the message at trimIndex is a user message with tool_result blocks
    if (trimIndex > 0 && trimIndex < conversation.messages.length) {
      const messageAtTrimPoint = conversation.messages[trimIndex];

      if (messageAtTrimPoint.role === 'user' && Array.isArray(messageAtTrimPoint.content)) {
        const hasToolResults = messageAtTrimPoint.content.some(
          (block: any) => block.type === 'tool_result'
        );

        // If this user message has tool_results, we need to also remove its
        // corresponding assistant message with tool_use blocks
        if (hasToolResults) {
          trimIndex++;
          this.logger.debug('Adjusted trim point to preserve tool_use/tool_result pair', {
            conversationId: conversation.id,
            originalTrimIndex: conversation.messages.length - maxMessages,
            adjustedTrimIndex: trimIndex,
          });
        }
      }
    }

    const removed = trimIndex;
    conversation.messages = conversation.messages.slice(trimIndex);

    this.logger.info('Trimmed conversation history', {
      conversationId: conversation.id,
      removedMessages: removed,
      remainingMessages: conversation.messages.length,
    });
  }

  /**
   * Start periodic cleanup of old conversations
   */
  private startConversationCleanup(): void {
    const cleanupIntervalMs = 5 * 60 * 1000; // 5 minutes

    this.cleanupInterval = setInterval(() => {
      this.cleanupOldConversations();
    }, cleanupIntervalMs);

    this.logger.info('Started conversation cleanup timer', {
      intervalMinutes: 5,
    });
  }

  /**
   * Remove conversations that haven't been accessed recently
   */
  private cleanupOldConversations(): void {
    const timeoutMs = this.config.conversationTimeoutMinutes * 60 * 1000;
    const now = Date.now();
    let removedCount = 0;

    for (const [id, conversation] of this.conversations.entries()) {
      const age = now - conversation.lastAccessedAt.getTime();
      if (age > timeoutMs) {
        this.conversations.delete(id);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.info('Cleaned up old conversations', {
        removed: removedCount,
        remaining: this.conversations.size,
      });
    }
  }

  /**
   * Get conversation count
   */
  getConversationCount(): number {
    return this.conversations.size;
  }

  /**
   * Shutdown the agent
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.logger.info('Agent shutdown complete');
  }
}
