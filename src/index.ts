/**
 * DANI Agent Service - Main Entry Point with Secrets Manager Support
 *
 * This is an updated version of index.ts that loads secrets from AWS Secrets Manager
 * at startup before initializing the application.
 *
 * MIGRATION INSTRUCTIONS:
 * 1. Backup current index.ts: cp src/index.ts src/index.ts.backup
 * 2. Replace index.ts with this file: cp src/index-with-secrets.ts src/index.ts
 * 3. Update imports in config.ts as shown in config-with-secrets.ts
 */

import express, { Request, Response, NextFunction } from 'express';
import { createConfigAsync, createLogger, logEnvironmentInfo } from './config';
import { AnthropicClient } from './anthropic-client';
import { BedrockClient } from './bedrock-client';
import { MCPClientManager } from './mcp-client';
import { DANIAgent } from './agent';
import { QueryAnalyzer } from './query-analyzer';
import {
  ChatRequest,
  ChatResponse,
  ErrorResponse,
  HealthResponse,
  ComplexityLevel,
  AppConfig,
  Logger,
} from './types';
import {
  requestTracingMiddleware,
  conversationContextMiddleware,
  errorLoggingMiddleware,
} from './shared/request-tracing-middleware';

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Global state
let agent: DANIAgent | null = null;
let mcpManager: MCPClientManager | null = null;
let queryAnalyzer: QueryAnalyzer | null = null;
let config: AppConfig | null = null;
let logger: Logger | null = null;
const startTime = Date.now();

// Request tracing middleware (lazy initialization)
// Will be properly initialized after logger is created
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!logger) {
    // Logger not yet initialized, skip tracing
    return next();
  }

  // Use structured logging middleware (cast logger to any to avoid type issues)
  return requestTracingMiddleware({ logger: logger as any })(req, res, next);
});

// Conversation context middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!logger) {
    return next();
  }
  return conversationContextMiddleware()(req, res, next);
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
  if (!mcpManager || !config) {
    return res.status(503).json({
      status: 'unhealthy',
      mcp_servers: {},
      uptime: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
      message: 'Service not initialized',
    });
  }

  const serverStatuses = mcpManager.getServerStatuses();
  const mcpServers: { [key: string]: 'connected' | 'disconnected' | 'error' } = {};

  let allConnected = true;
  for (const [name, status] of serverStatuses.entries()) {
    if (status.connected) {
      mcpServers[name] = 'connected';
    } else if (status.error) {
      mcpServers[name] = 'error';
      allConnected = false;
    } else {
      mcpServers[name] = 'disconnected';
      allConnected = false;
    }
  }

  const healthStatus = allConnected ? 'healthy' : 'degraded';

  return res.json({
    status: healthStatus,
    mcp_servers: mcpServers,
    uptime: (Date.now() - startTime) / 1000,
    timestamp: new Date().toISOString(),
    task_definition: process.env.ECS_TASK_DEFINITION || 'unknown',
  });
});

/**
 * Chat endpoint - main agent interface
 */
app.post('/chat', async (req: Request<{}, {}, ChatRequest>, res: Response<ChatResponse | ErrorResponse>) => {
  try {
    // Validate request body
    const { message, conversationId, complexity, userId, drmApiKeys, messages } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid "message" field',
      });
    }

    // Validate complexity if provided
    let selectedComplexity: ComplexityLevel | undefined = undefined;
    if (complexity) {
      const validComplexities: ComplexityLevel[] = ['SIMPLE', 'PROCEDURAL', 'ANALYTICAL'];
      if (!validComplexities.includes(complexity)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Invalid complexity level. Must be one of: ${validComplexities.join(', ')}`,
        });
      }
      selectedComplexity = complexity;
    }

    if (!agent) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Agent not initialized',
      });
    }

    // Build user context
    const userContext = userId || drmApiKeys ? { userId, drmApiKeys } : undefined;

    // Process the message (auto-detect complexity if not provided)
    const result = await agent.processMessage(
      message.trim(),
      conversationId,
      selectedComplexity,
      userContext,
      messages
    );

    // Return response
    return res.json({
      response: result.response,
      conversationId: result.conversationId,
      model: result.model,
      usage: result.usage,
      iterations: result.iterations,
      toolCallDetails: result.toolCallDetails,
      reasoningSteps: result.reasoningSteps,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const conversationId = req.body.conversationId;

    if (logger) {
      logger.error('Error in /chat endpoint', {
        error: errorMessage,
        conversationId,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      message: errorMessage,
      conversationId,
    });
  }
});

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.path} not found`,
  });
});

/**
 * Error logging middleware (logs errors with full context)
 */
app.use(errorLoggingMiddleware());

/**
 * Error handler (sends error response to client)
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
});

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  console.log('[Startup] Initializing DANI Agent Service...');

  try {
    // Step 1: Load configuration (this loads secrets from AWS Secrets Manager)
    console.log('[Startup] Step 1: Loading configuration and secrets...');
    config = await createConfigAsync();
    logger = createLogger(config);

    // Log environment information
    logEnvironmentInfo(logger);

    logger.info('Configuration loaded successfully', {
      nodeEnv: config.nodeEnv,
      port: config.port,
      mcpServerCount: config.mcpServers.length,
      useBedrock: config.useBedrock,
    });

    // Step 2: Initialize MCP client manager
    console.log('[Startup] Step 2: Initializing MCP clients...');
    mcpManager = new MCPClientManager(logger, config.cacheTTL);
    await mcpManager.initialize(config.mcpServers);

    logger.info('MCP clients initialized', {
      servers: config.mcpServers.map(s => s.name),
    });

    // Step 3: Initialize AI client (Bedrock or Anthropic)
    console.log('[Startup] Step 3: Initializing AI client...');
    let aiClient: AnthropicClient | BedrockClient;

    if (config.useBedrock) {
      logger.info('Initializing AWS Bedrock client', {
        region: config.awsRegion,
      });
      aiClient = new BedrockClient(
        config.awsRegion!,
        config.systemMessage,
        logger,
        config.awsAccessKeyId,
        config.awsSecretAccessKey
      );

      // Initialize Query Analyzer for Bedrock
      queryAnalyzer = new QueryAnalyzer(
        config.awsRegion!,
        logger,
        true,
        config.awsAccessKeyId,
        config.awsSecretAccessKey
      );
      logger.info('QueryAnalyzer initialized for automatic complexity detection (Bedrock)');
    } else {
      logger.info('Initializing Anthropic client');
      aiClient = new AnthropicClient(
        config.anthropicApiKey!,
        config.systemMessage,
        logger,
        config.cacheTTL
      );

      // Initialize Query Analyzer for Anthropic
      queryAnalyzer = new QueryAnalyzer(config.anthropicApiKey!, logger, false);
      logger.info('QueryAnalyzer initialized for automatic complexity detection (Anthropic)');
    }

    // Step 4: Initialize DANI agent
    console.log('[Startup] Step 4: Initializing DANI agent...');
    agent = new DANIAgent(aiClient, mcpManager, config, logger, queryAnalyzer);

    logger.info('DANI Agent Service initialized successfully', {
      availableTools: mcpManager.getAnthropicTools().length,
      autoComplexityDetection: true,
    });

    console.log('[Startup] ✓ Initialization complete!');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Startup] ✗ Failed to initialize DANI Agent Service:', errorMessage);

    if (logger) {
      logger.error('Failed to initialize DANI Agent Service', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    throw error;
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

  if (logger) {
    logger.info(`Received ${signal}, starting graceful shutdown`);
  }

  try {
    // Stop accepting new connections
    if (server) {
      server.close(() => {
        console.log('[Shutdown] HTTP server closed');
        if (logger) {
          logger.info('HTTP server closed');
        }
      });
    }

    // Shutdown agent
    if (agent) {
      agent.shutdown();
    }

    // Close MCP connections
    if (mcpManager) {
      await mcpManager.close();
    }

    console.log('[Shutdown] Graceful shutdown complete');
    if (logger) {
      logger.info('Graceful shutdown complete');
    }

    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Shutdown] Error during shutdown:', errorMessage);

    if (logger) {
      logger.error('Error during shutdown', { error: errorMessage });
    }

    process.exit(1);
  }
}

/**
 * Start the server
 */
let server: ReturnType<typeof app.listen> | null = null;

async function start(): Promise<void> {
  try {
    console.log('[Server] Starting DANI Agent Service...');

    // Initialize the application (loads secrets, connects to MCP servers, etc.)
    await initialize();

    // Start the HTTP server
    // Bind to 0.0.0.0 to accept connections from other containers in ECS tasks
    const port = config?.port || 8080;
    server = app.listen(port, '0.0.0.0', () => {
      console.log(`[Server] ✓ DANI Agent Service listening on port ${port}`);
      console.log(`[Server]   Endpoints:`);
      console.log(`[Server]     POST http://localhost:${port}/chat`);
      console.log(`[Server]     GET  http://localhost:${port}/health`);

      if (logger) {
        logger.info(`DANI Agent Service listening on port ${port}`, {
          environment: config?.nodeEnv,
          endpoints: [
            `POST http://localhost:${port}/chat`,
            `GET http://localhost:${port}/health`,
          ],
        });
      }
    });

    // Setup graceful shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Server] ✗ Failed to start server:', errorMessage);

    if (logger) {
      logger.error('Failed to start server', { error: errorMessage });
    }

    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  start().catch(error => {
    console.error('[Fatal] Fatal error during startup:', error);
    process.exit(1);
  });
}

export { app, initialize, shutdown };
