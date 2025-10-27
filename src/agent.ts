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
import { ToolResult, CorrectedResponse } from './types/validation.types';
import { AIClient } from './ai-client.interface';
import { MCPClientManager, UserContext } from './mcp-client';
import { QueryAnalyzer } from './query-analyzer';
import { ResponseParser } from './response-parser';
import { MathValidator } from './math-validator';
import { ResponseCorrector } from './response-corrector';

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
    toolResultsCache: ToolResult[] = []
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

      this.logger.info('Claude requested tool use', {
        conversationId: conversation.id,
        iteration,
        toolCount: toolUses.length,
        tools: toolUses.map(t => t.name),
        iterationUsage: currentUsage,
      });

      // Add assistant's response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute all requested tools with user context
      const userContext = this.conversationUserContexts.get(conversation.id);
      const toolResults = await this.executeTools(toolUses, userContext);

      // Cache tool results for validation
      const cachedResults: ToolResult[] = toolResults.map((result, index) => ({
        tool_use_id: result.tool_use_id,
        toolName: toolUses[index].name,
        type: 'tool_result',
        content: result.content as string,
        is_error: result.is_error,
        timestamp: new Date(),
      }));
      toolResultsCache.push(...cachedResults);

      // Add tool results to conversation as user message
      conversation.messages.push({
        role: 'user',
        content: toolResults,
      });

      // Trim conversation history to control token usage
      this.trimConversationHistory(conversation);

      // Continue the loop with the tool results
      return this.agenticLoop(conversation, complexity, iteration + 1, cumulativeUsage, toolResultsCache);
    } else {
      // Final response received
      const textContent = this.aiClient.extractTextContent(response);
      const thinkingContent = this.aiClient.extractThinkingContent(response);

      // Calculate total cumulative usage
      const totalUsage = this.sumUsageStats(cumulativeUsage);

      // Validate and correct math errors (filter out error results first)
      const successfulToolResults = toolResultsCache.filter(tr => !tr.is_error);
      const correctedResponse = await this.validateAndCorrectResponse(
        textContent,
        successfulToolResults,
        conversation.id
      );

      this.logger.info('Final response received', {
        conversationId: conversation.id,
        iterations: iteration,
        responseLength: textContent.length,
        hasThinking: !!thinkingContent,
        totalUsage,
        usageBreakdown: cumulativeUsage,
        mathCorrectionsMade: correctedResponse.correctionsMade,
        correctionSeverity: correctedResponse.severity,
      });

      // Add final response to conversation (use corrected text)
      conversation.messages.push({
        role: 'assistant',
        content: correctedResponse.text,
      });

      // Get model from response
      const modelConfig = response.model;

      return {
        response: correctedResponse.text,
        conversationId: conversation.id,
        model: modelConfig,
        usage: totalUsage,
        thinking: thinkingContent,
        usageBreakdown: cumulativeUsage,
        iterations: iteration,
        mathCorrections: correctedResponse.correctionsMade ? correctedResponse.corrections : undefined,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  private async executeTools(
    toolUses: Anthropic.ToolUseBlock[],
    userContext?: UserContext
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const toolExecutions = toolUses.map(async (toolUse) => {
      const startTime = Date.now();

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
   * Validate and correct mathematical errors in response
   */
  private async validateAndCorrectResponse(
    responseText: string,
    toolResults: ToolResult[],
    conversationId: string
  ): Promise<CorrectedResponse> {
    const parser = new ResponseParser(this.logger);
    const validator = new MathValidator(this.logger);
    const corrector = new ResponseCorrector(this.logger);

    // Step 1: Parse response to extract claims and lists
    const parsed = parser.parse(responseText);

    // Step 2: Validate all numeric claims against tool results
    const validations = validator.validateAll(parsed.claims, toolResults);

    // Step 3: Check for count/list mismatches
    const mismatches = parser.detectCountListMismatches(parsed);

    if (mismatches.length > 0) {
      this.logger.warn('Detected count/list mismatches', {
        conversationId,
        mismatchCount: mismatches.length,
        mismatches: mismatches.map(m => ({
          claimed: m.claimedCount,
          actual: m.actualCount,
          entity: m.list.type,
        })),
      });
    }

    // Step 4: Check if corrections are needed
    const errors = validations.filter(v => !v.isValid);

    if (errors.length === 0 && mismatches.length === 0) {
      // No corrections needed
      return {
        text: responseText,
        correctionsMade: false,
        corrections: [],
        severity: 'none',
        validationResults: validations,
        metadata: {
          originalLength: responseText.length,
          correctedLength: responseText.length,
          claimsValidated: validations.length,
          claimsCorrected: 0,
          listsValidated: parsed.lists.length,
          listsCorrected: 0,
        },
      };
    }

    // Step 5: Auto-correct errors
    this.logger.info('Applying math corrections', {
      conversationId,
      errorCount: errors.length,
      mismatchCount: mismatches.length,
      claimTypes: errors.map(e => e.claim.type),
    });

    const corrected = corrector.correctResponse(parsed, validations, toolResults);

    // Step 6: Log corrections for monitoring
    if (corrected.correctionsMade) {
      this.logger.warn('Math corrections applied', {
        conversationId,
        severity: corrected.severity,
        correctionsCount: corrected.corrections.length,
        corrections: corrected.corrections.map(c => ({
          type: c.type,
          original: c.original,
          corrected: c.corrected,
          reason: c.reason,
        })),
      });
    }

    return corrected;
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
