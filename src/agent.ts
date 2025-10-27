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
  UsageStats,
} from './types';
import { AIClient } from './ai-client.interface';
import { MCPClientManager, UserContext } from './mcp-client';
import { QueryAnalyzer } from './query-analyzer';

/**
 * DANI Agent
 * Main agent class that orchestrates Claude API calls, tool execution, and conversation management
 */
export class DANIAgent {
  private aiClient: AIClient;
  private mcpManager: MCPClientManager;
  private logger: Logger;
  private config: AppConfig;
  private queryAnalyzer?: QueryAnalyzer;
  private conversations: Map<string, Conversation> = new Map();
  private conversationUserContexts: Map<string, UserContext> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    aiClient: AIClient,
    mcpManager: MCPClientManager,
    config: AppConfig,
    logger: Logger,
    queryAnalyzer?: QueryAnalyzer
  ) {
    this.aiClient = aiClient;
    this.mcpManager = mcpManager;
    this.config = config;
    this.logger = logger;
    this.queryAnalyzer = queryAnalyzer;

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
    complexity?: ComplexityLevel,
    userContext?: UserContext
  ): Promise<AgentResponse> {
    // Get or create conversation
    const convId = conversationId || uuidv4();
    const conversation = this.getOrCreateConversation(convId);

    // Store user context for this conversation
    if (userContext) {
      this.conversationUserContexts.set(convId, userContext);
    }

    // Determine complexity level
    let finalComplexity: ComplexityLevel;
    let complexitySource: 'auto' | 'manual';

    if (complexity) {
      // Manual complexity provided
      finalComplexity = complexity;
      complexitySource = 'manual';
      this.logger.info('Using manual complexity level', {
        conversationId: convId,
        complexity: finalComplexity,
      });
    } else {
      // Auto-detect complexity
      if (this.queryAnalyzer) {
        this.logger.info('Auto-detecting query complexity', {
          conversationId: convId,
        });
        finalComplexity = await this.queryAnalyzer.analyzeQuery(userMessage);
        complexitySource = 'auto';
        this.logger.info('Auto-detected complexity level', {
          conversationId: convId,
          complexity: finalComplexity,
        });
      } else {
        // No analyzer available, default to ANALYTICAL
        finalComplexity = 'ANALYTICAL';
        complexitySource = 'manual';
        this.logger.warn('No QueryAnalyzer available, defaulting to ANALYTICAL', {
          conversationId: convId,
        });
      }
    }

    this.logger.info('Processing message', {
      conversationId: convId,
      complexity: finalComplexity,
      complexitySource,
      messageLength: userMessage.length,
      historySize: conversation.messages.length,
    });

    try {
      // Add user message to conversation
      conversation.messages.push({
        role: 'user',
        content: userMessage,
      });

      // Trim conversation history to control token usage
      this.trimConversationHistory(conversation);

      // Execute the agentic loop
      const result = await this.agenticLoop(conversation, finalComplexity);

      // Update conversation metadata
      conversation.lastAccessedAt = new Date();
      conversation.model = result.model;

      return {
        ...result,
        conversationId: convId,
        complexityDetected: finalComplexity,
        complexitySource,
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
    iteration: number = 1,
    cumulativeUsage: UsageStats[] = [],
    toolCallDetailsAccumulator: import('./types').ToolCallDetail[] = [],
    reasoningStepsAccumulator: import('./types').ReasoningStep[] = []
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
    const response = await this.aiClient.sendMessage(
      conversation.messages,
      tools,
      complexity
    );

    // Track usage for this iteration
    const currentUsage = this.aiClient.extractUsageStats(response);
    cumulativeUsage.push(currentUsage);

    // Check stop reason
    if (this.aiClient.hasToolUse(response)) {
      // Extract tool uses
      const toolUses = this.aiClient.extractToolUses(response);

      // Extract thinking content if available
      const thinkingContent = this.aiClient.extractThinkingContent(response);

      this.logger.info('Claude requested tool use', {
        conversationId: conversation.id,
        iteration,
        toolCount: toolUses.length,
        tools: toolUses.map(t => t.name),
        iterationUsage: currentUsage,
      });

      // Record reasoning step
      reasoningStepsAccumulator.push({
        iteration,
        timestamp: new Date().toISOString(),
        toolsRequested: toolUses.map(t => t.name),
        thinking: thinkingContent,
      });

      // Add assistant's response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute all requested tools with user context
      const userContext = this.conversationUserContexts.get(conversation.id);
      const { toolResults, toolDetails } = await this.executeTools(toolUses, userContext, iteration);

      // Accumulate tool call details
      toolCallDetailsAccumulator.push(...toolDetails);

      // Add tool results to conversation as user message
      conversation.messages.push({
        role: 'user',
        content: toolResults,
      });

      // Trim conversation history to control token usage
      this.trimConversationHistory(conversation);

      // Continue the loop with the tool results
      return this.agenticLoop(
        conversation,
        complexity,
        iteration + 1,
        cumulativeUsage,
        toolCallDetailsAccumulator,
        reasoningStepsAccumulator
      );
    } else {
      // Final response received
      const textContent = this.aiClient.extractTextContent(response);
      const thinkingContent = this.aiClient.extractThinkingContent(response);

      // Calculate total cumulative usage
      const totalUsage = this.sumUsageStats(cumulativeUsage);

      this.logger.info('Final response received', {
        conversationId: conversation.id,
        iterations: iteration,
        responseLength: textContent.length,
        hasThinking: !!thinkingContent,
        totalUsage,
        usageBreakdown: cumulativeUsage,
      });

      // Add final response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: textContent,
      });

      // Get model from response
      const modelConfig = response.model;

      return {
        response: textContent,
        conversationId: conversation.id,
        model: modelConfig,
        usage: totalUsage,
        thinking: thinkingContent,
        usageBreakdown: cumulativeUsage,
        iterations: iteration,
        toolCallDetails: toolCallDetailsAccumulator.length > 0 ? toolCallDetailsAccumulator : undefined,
        reasoningSteps: reasoningStepsAccumulator.length > 0 ? reasoningStepsAccumulator : undefined,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  private async executeTools(
    toolUses: Anthropic.ToolUseBlock[],
    userContext?: UserContext,
    iteration: number = 1
  ): Promise<{
    toolResults: Anthropic.ToolResultBlockParam[];
    toolDetails: import('./types').ToolCallDetail[];
  }> {
    const toolExecutions = toolUses.map(async (toolUse) => {
      const startTime = Date.now();
      const timestamp = new Date().toISOString();

      try {
        const result = await this.mcpManager.executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          userContext
        );

        const duration = Date.now() - startTime;

        this.logger.info('Tool execution completed', {
          tool: toolUse.name,
          duration: `${duration}ms`,
          isError: result.isError,
        });

        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        };

        const toolDetail: import('./types').ToolCallDetail = {
          toolName: toolUse.name,
          server: result.server,
          input: toolUse.input as Record<string, unknown>,
          output: result.content,
          timestamp,
          duration,
          isError: result.isError || false,
          iteration,
        };

        return { toolResult, toolDetail };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const duration = Date.now() - startTime;

        this.logger.error('Tool execution failed', {
          tool: toolUse.name,
          duration: `${duration}ms`,
          error: errorMessage,
        });

        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: `Error: ${errorMessage}`,
          is_error: true,
        };

        const toolDetail: import('./types').ToolCallDetail = {
          toolName: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
          output: `Error: ${errorMessage}`,
          timestamp,
          duration,
          isError: true,
          iteration,
        };

        return { toolResult, toolDetail };
      }
    });

    const results = await Promise.all(toolExecutions);

    return {
      toolResults: results.map(r => r.toolResult),
      toolDetails: results.map(r => r.toolDetail),
    };
  }

  /**
   * Trim conversation history to keep only the most recent messages
   * This reduces token usage while maintaining conversation context
   */
  private trimConversationHistory(conversation: Conversation): void {
    const maxMessages = this.config.maxConversationMessages;

    // If no limit is set or conversation is within limit, do nothing
    if (!maxMessages || conversation.messages.length <= maxMessages) {
      return;
    }

    // Calculate how many messages to remove
    const messagesToRemove = conversation.messages.length - maxMessages;

    // Remove oldest messages (keeping newest ones)
    const removedMessages = conversation.messages.splice(0, messagesToRemove);

    this.logger.info('Trimmed conversation history', {
      conversationId: conversation.id,
      removedCount: removedMessages.length,
      remainingCount: conversation.messages.length,
      maxMessages,
    });
  }

  /**
   * Sum usage statistics across multiple iterations
   */
  private sumUsageStats(usageArray: UsageStats[]): UsageStats {
    return usageArray.reduce((total, current) => ({
      input_tokens: total.input_tokens + current.input_tokens,
      output_tokens: total.output_tokens + current.output_tokens,
      cache_creation_tokens: total.cache_creation_tokens + current.cache_creation_tokens,
      cache_read_tokens: total.cache_read_tokens + current.cache_read_tokens,
      cache_creation_5m_tokens: (total.cache_creation_5m_tokens || 0) + (current.cache_creation_5m_tokens || 0),
      cache_creation_1h_tokens: (total.cache_creation_1h_tokens || 0) + (current.cache_creation_1h_tokens || 0),
      cache_read_5m_tokens: (total.cache_read_5m_tokens || 0) + (current.cache_read_5m_tokens || 0),
      cache_read_1h_tokens: (total.cache_read_1h_tokens || 0) + (current.cache_read_1h_tokens || 0),
    }), {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
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
