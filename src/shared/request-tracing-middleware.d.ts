/**
 * Request Tracing Middleware for Express
 *
 * Automatically adds correlation IDs to all requests and logs them.
 * Correlation IDs flow across all services (webchat → agent → MCP servers)
 * making it easy to trace a user's request end-to-end.
 */
import { Request, Response, NextFunction } from 'express';
import { StructuredLogger } from './structured-logger';
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
    logger: StructuredLogger;
    logRequests?: boolean;
    logResponses?: boolean;
    includeSensitiveHeaders?: boolean;
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
export declare function requestTracingMiddleware(options: RequestTracingOptions): (req: Request, res: Response, next: NextFunction) => void;
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
export declare function conversationContextMiddleware(): (req: Request, res: Response, next: NextFunction) => any;
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
export declare function errorLoggingMiddleware(): (err: Error, req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=request-tracing-middleware.d.ts.map