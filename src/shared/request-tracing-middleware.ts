/**
 * Request Tracing Middleware for Express
 *
 * Automatically adds correlation IDs to all requests and logs them.
 * Correlation IDs flow across all services (webchat → agent → MCP servers)
 * making it easy to trace a user's request end-to-end.
 */

import { Request, Response, NextFunction } from 'express';
import { StructuredLogger, generateCorrelationId, extractCorrelationId, LogContext } from './structured-logger';

// Extend Express Request type to include our custom properties
declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      logger?: StructuredLogger;
      startTime?: number;
    }
  }
}

export interface RequestTracingOptions {
  logger: StructuredLogger | any;  // Accept any logger with compatible interface
  logRequests?: boolean;  // Log all requests (default: true)
  logResponses?: boolean; // Log all responses (default: true)
  includeSensitiveHeaders?: boolean; // Include all headers in logs (default: false)
}

/**
 * Request Tracing Middleware
 *
 * Usage:
 * ```typescript
 * import { requestTracingMiddleware } from './shared/request-tracing-middleware';
 * import { StructuredLogger } from './shared/structured-logger';
 *
 * const logger = new StructuredLogger('dani-agent');
 * app.use(requestTracingMiddleware({ logger }));
 * ```
 */
export function requestTracingMiddleware(options: RequestTracingOptions) {
  const {
    logger,
    logRequests = true,
    logResponses = true,
    includeSensitiveHeaders = false,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Generate or extract correlation ID
    const correlationId = extractCorrelationId(req.headers) || generateCorrelationId();
    req.correlationId = correlationId;
    req.startTime = Date.now();

    // Add correlation ID to response headers
    res.setHeader('X-Correlation-ID', correlationId);

    // Create child logger with request context
    const baseContext: LogContext = {
      requestId: correlationId,
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection.remoteAddress,
    };

    req.logger = logger.child(baseContext);

    // Log incoming request
    if (logRequests) {
      const requestContext: LogContext = {
        ...baseContext,
        userAgent: req.headers['user-agent'],
        queryParams: Object.keys(req.query).length > 0 ? req.query : undefined,
      };

      // Include headers if configured
      if (includeSensitiveHeaders) {
        requestContext.headers = req.headers;
      }

      req.logger!.info('Incoming request', requestContext);
    }

    // Log response when finished
    if (logResponses) {
      const originalSend = res.send;

      res.send = function (body): Response {
        const durationMs = req.startTime ? Date.now() - req.startTime : undefined;

        const responseContext: LogContext = {
          ...baseContext,
          statusCode: res.statusCode,
          durationMs,
        };

        // Log level based on status code
        if (res.statusCode >= 500) {
          req.logger!.error('Request failed', responseContext);
        } else if (res.statusCode >= 400) {
          req.logger!.warn('Request error', responseContext);
        } else {
          req.logger!.info('Request completed', responseContext);
        }

        return originalSend.call(this, body);
      };
    }

    next();
  };
}

/**
 * Conversation Context Middleware
 *
 * Extracts conversation and user context from request body and adds to logger
 *
 * Usage:
 * ```typescript
 * app.use(conversationContextMiddleware());
 * ```
 */
export function conversationContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.logger) {
      return next();
    }

    // Extract context from request body
    const { conversationId, userId, userEmail, sessionId } = req.body || {};

    if (conversationId || userId || userEmail || sessionId) {
      // Create new child logger with conversation context
      const conversationContext: LogContext = {
        conversationId,
        userId,
        userEmail,
        sessionId,
      };

      req.logger = req.logger.child(conversationContext);
    }

    next();
  };
}

/**
 * Error Logging Middleware
 *
 * Catches all errors and logs them with full context
 *
 * Usage (add AFTER all routes):
 * ```typescript
 * app.use(errorLoggingMiddleware());
 * ```
 */
export function errorLoggingMiddleware() {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    const logger = req.logger || new StructuredLogger('unknown-service');

    logger.error('Unhandled error', {
      error: err,
      requestId: req.correlationId,
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query,
    });

    // Pass error to next error handler
    next(err);
  };
}
