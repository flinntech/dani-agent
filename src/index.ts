/**
 * DANI Agent Service - Main Entry Point
 * Express HTTP API server
 */

import express, { Request, Response, NextFunction } from 'express';
import { config, logger } from './config';
import { AnthropicClient } from './anthropic-client';
import { MCPClientManager } from './mcp-client';
import { DANIAgent } from './agent';
import { QueryAnalyzer } from './query-analyzer';
import {
  ChatRequest,
  ChatResponse,
  ErrorResponse,
  HealthResponse,
  ComplexityLevel,
} from './types';

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('HTTP Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });

  next();
});

// Global state
let agent: DANIAgent | null = null;
let mcpManager: MCPClientManager | null = null;
let queryAnalyzer: QueryAnalyzer | null = null;
const startTime = Date.now();

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
  if (!mcpManager) {
    return res.status(503).json({
      status: 'unhealthy',
      mcp_servers: {},
      uptime: (Date.now() - startTime) / 1000,
      timestamp: new Date().toISOString(),
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
  });
});

/**
 * Chat endpoint - main agent interface
 */
app.post('/chat', async (req: Request<{}, {}, ChatRequest>, res: Response<ChatResponse | ErrorResponse>) => {
  try {
    // Validate request body
    const { message, conversationId, complexity, userId, drmApiKeys } = req.body;

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
      userContext
    );

    // Return response
    return res.json({
      response: result.response,
      conversationId: result.conversationId,
      model: result.model,
      usage: result.usage,
      iterations: result.iterations,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const conversationId = req.body.conversationId;

    logger.error('Error in /chat endpoint', {
      error: errorMessage,
      conversationId,
    });

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
 * Error handler
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
});

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  logger.info('Initializing DANI Agent Service', {
    nodeEnv: config.nodeEnv,
    port: config.port,
    mcpServerCount: config.mcpServers.length,
  });

  try {
    // Initialize MCP client manager
    mcpManager = new MCPClientManager(logger);
    await mcpManager.initialize(config.mcpServers);

    // Initialize Anthropic client
    const anthropicClient = new AnthropicClient(
      config.anthropicApiKey,
      config.systemMessage,
      logger,
      config.cacheTTL
    );

    // Initialize Query Analyzer for auto-detection
    queryAnalyzer = new QueryAnalyzer(config.anthropicApiKey, logger);
    logger.info('QueryAnalyzer initialized for automatic complexity detection');

    // Initialize DANI agent
    agent = new DANIAgent(anthropicClient, mcpManager, config, logger, queryAnalyzer);

    logger.info('DANI Agent Service initialized successfully', {
      availableTools: mcpManager.getAnthropicTools().length,
      autoComplexityDetection: true,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to initialize DANI Agent Service', {
      error: errorMessage,
    });
    throw error;
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  try {
    // Stop accepting new connections
    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
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

    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Error during shutdown', { error: errorMessage });
    process.exit(1);
  }
}

/**
 * Start the server
 */
let server: ReturnType<typeof app.listen> | null = null;

async function start(): Promise<void> {
  try {
    // Initialize the application
    await initialize();

    // Start the HTTP server
    server = app.listen(config.port, () => {
      logger.info(`DANI Agent Service listening on port ${config.port}`, {
        environment: config.nodeEnv,
        endpoints: [
          `POST http://localhost:${config.port}/chat`,
          `GET http://localhost:${config.port}/health`,
        ],
      });
    });

    // Setup graceful shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start server', { error: errorMessage });
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  start().catch(error => {
    console.error('Fatal error during startup:', error);
    process.exit(1);
  });
}

export { app, initialize, shutdown };
