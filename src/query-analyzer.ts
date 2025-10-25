/**
 * Query Complexity Analyzer
 * Uses Claude Haiku to automatically detect query complexity level
 */

import Anthropic from '@anthropic-ai/sdk';
import { ComplexityLevel, Logger } from './types';

/**
 * System prompt for query complexity analysis
 */
const ANALYSIS_SYSTEM_PROMPT = `You are a query complexity analyzer. Classify queries into exactly one category:

SIMPLE: Quick lookups, status checks, single-device queries
- "What's the status of device XYZ?"
- "List all devices"
- "Is service X down?"

PROCEDURAL: Multi-step tasks, comparisons, filtering
- "Show me all offline devices in region A"
- "Compare device X and Y uptime"
- "List devices with high CPU usage"

ANALYTICAL: Complex analysis, trends, correlations, diagnostics
- "Analyze connectivity patterns over the last week"
- "Why are devices in region X failing?"
- "Identify root cause of outages"

Respond with ONLY one word: SIMPLE, PROCEDURAL, or ANALYTICAL`;

/**
 * QueryAnalyzer
 * Analyzes user queries to automatically determine complexity level
 */
export class QueryAnalyzer {
  private client: Anthropic;
  private logger: Logger;
  private model: string = 'claude-haiku-4-5-20251001';
  private maxTokens: number = 100;

  constructor(apiKey: string, logger: Logger) {
    this.client = new Anthropic({ apiKey });
    this.logger = logger;
  }

  /**
   * Analyze a user query and return the detected complexity level
   * Defaults to ANALYTICAL on any errors for safety
   */
  async analyzeQuery(query: string): Promise<ComplexityLevel> {
    const startTime = Date.now();

    try {
      this.logger.debug('Analyzing query complexity', {
        queryLength: query.length,
        model: this.model,
      });

      // Call Claude Haiku for analysis
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0,
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
      });

      // Extract the response text
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );

      if (!textBlock) {
        this.logger.warn('No text response from query analyzer, defaulting to ANALYTICAL');
        return 'ANALYTICAL';
      }

      // Parse the complexity level from response
      const responseText = textBlock.text.trim().toUpperCase();
      const complexity = this.parseComplexity(responseText);

      // Log the analysis results
      const duration = Date.now() - startTime;
      this.logger.info('Query complexity detected', {
        complexity,
        duration: `${duration}ms`,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: this.model,
      });

      return complexity;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Error analyzing query complexity, defaulting to ANALYTICAL', {
        error: errorMessage,
        duration: `${duration}ms`,
      });

      // Default to ANALYTICAL on error (safest option)
      return 'ANALYTICAL';
    }
  }

  /**
   * Parse the complexity level from the analyzer's response
   * Returns ANALYTICAL as default if parsing fails
   */
  private parseComplexity(response: string): ComplexityLevel {
    // Extract the complexity keyword from response
    if (response.includes('SIMPLE')) {
      return 'SIMPLE';
    } else if (response.includes('PROCEDURAL')) {
      return 'PROCEDURAL';
    } else if (response.includes('ANALYTICAL')) {
      return 'ANALYTICAL';
    }

    // If we can't parse it, default to ANALYTICAL for safety
    this.logger.warn('Could not parse complexity from response, defaulting to ANALYTICAL', {
      response,
    });
    return 'ANALYTICAL';
  }
}
