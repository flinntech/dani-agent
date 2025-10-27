/**
 * Query Complexity Analyzer
 * Uses Claude Haiku to automatically detect query complexity level
 * Supports both Anthropic Direct API and AWS Bedrock
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
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
  private anthropicClient?: Anthropic;
  private bedrockClient?: BedrockRuntimeClient;
  private logger: Logger;
  private useBedrock: boolean;
  private model: string = 'claude-haiku-4-5-20251001';
  private bedrockModelId: string = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  private maxTokens: number = 100;

  constructor(
    apiKeyOrRegion: string,
    logger: Logger,
    useBedrock: boolean = false,
    awsAccessKeyId?: string,
    awsSecretAccessKey?: string
  ) {
    this.logger = logger;
    this.useBedrock = useBedrock;

    if (useBedrock) {
      // Initialize Bedrock client
      const credentials = awsAccessKeyId && awsSecretAccessKey
        ? { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
        : undefined;

      this.bedrockClient = new BedrockRuntimeClient({
        region: apiKeyOrRegion,
        credentials,
      });
    } else {
      // Initialize Anthropic client
      this.anthropicClient = new Anthropic({ apiKey: apiKeyOrRegion });
    }
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
        useBedrock: this.useBedrock,
      });

      let responseText: string;
      let inputTokens: number = 0;
      let outputTokens: number = 0;

      if (this.useBedrock && this.bedrockClient) {
        // Use Bedrock
        const requestBody = {
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: this.maxTokens,
          temperature: 0,
          system: ANALYSIS_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: query,
            },
          ],
        };

        const command = new InvokeModelCommand({
          modelId: this.bedrockModelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(requestBody),
        });

        const response = await this.bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        const textBlock = responseBody.content.find((block: any) => block.type === 'text');
        if (!textBlock) {
          this.logger.warn('No text response from query analyzer (Bedrock), defaulting to ANALYTICAL');
          return 'ANALYTICAL';
        }

        responseText = textBlock.text.trim().toUpperCase();
        inputTokens = responseBody.usage.input_tokens;
        outputTokens = responseBody.usage.output_tokens;
      } else if (this.anthropicClient) {
        // Use Anthropic direct
        const response = await this.anthropicClient.messages.create({
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

        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === 'text'
        );

        if (!textBlock) {
          this.logger.warn('No text response from query analyzer (Anthropic), defaulting to ANALYTICAL');
          return 'ANALYTICAL';
        }

        responseText = textBlock.text.trim().toUpperCase();
        inputTokens = response.usage.input_tokens;
        outputTokens = response.usage.output_tokens;
      } else {
        throw new Error('No AI client initialized');
      }

      // Parse the complexity level from response
      const complexity = this.parseComplexity(responseText);

      // Log the analysis results
      const duration = Date.now() - startTime;
      this.logger.info('Query complexity detected', {
        complexity,
        duration: `${duration}ms`,
        inputTokens,
        outputTokens,
        model: this.model,
        useBedrock: this.useBedrock,
      });

      return complexity;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Error analyzing query complexity, defaulting to ANALYTICAL', {
        error: errorMessage,
        duration: `${duration}ms`,
        useBedrock: this.useBedrock,
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
