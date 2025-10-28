/**
 * Structured Logger for DANI Application
 *
 * Provides JSON-formatted logging with request tracing, performance metrics,
 * and CloudWatch-optimized output.
 *
 * Key Features:
 * - Request correlation IDs that flow across all services
 * - Performance timing for all operations
 * - ECS metadata automatically included
 * - CloudWatch Insights compatible JSON format
 * - Structured error logging with full context
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogContext {
    requestId?: string;
    conversationId?: string;
    userId?: string;
    userEmail?: string;
    sessionId?: string;
    durationMs?: number;
    operation?: string;
    method?: string;
    path?: string;
    statusCode?: number;
    ip?: string;
    error?: Error | string;
    stackTrace?: string;
    [key: string]: any;
}
export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    context: LogContext;
    ecsTaskId?: string;
    ecsContainerName?: string;
    ecsTaskDefinition?: string;
    awsRegion?: string;
}
/**
 * Structured Logger Class
 */
export declare class StructuredLogger {
    private serviceName;
    private minLevel;
    private ecsMetadata;
    constructor(serviceName: string, minLevel?: LogLevel);
    /**
     * Load ECS metadata from environment
     */
    private loadECSMetadata;
    /**
     * Extract ECS task ID from metadata
     */
    private getECSTaskId;
    /**
     * Check if log level should be output
     */
    private shouldLog;
    /**
     * Create a log entry
     */
    private createLogEntry;
    /**
     * Output log entry
     */
    private log;
    /**
     * Log debug message
     */
    debug(message: string, context?: LogContext): void;
    /**
     * Log info message
     */
    info(message: string, context?: LogContext): void;
    /**
     * Log warning message
     */
    warn(message: string, context?: LogContext): void;
    /**
     * Log error message
     */
    error(message: string, context?: LogContext): void;
    /**
     * Create a child logger with pre-populated context
     * Useful for adding request-specific context to all logs
     */
    child(additionalContext: LogContext): StructuredLogger;
    /**
     * Time an async operation and log performance
     */
    timeAsync<T>(operation: string, fn: () => Promise<T>, context?: LogContext): Promise<T>;
    /**
     * Time a sync operation and log performance
     */
    time<T>(operation: string, fn: () => T, context?: LogContext): T;
}
/**
 * Helper: Generate correlation ID for request tracing
 */
export declare function generateCorrelationId(): string;
/**
 * Helper: Extract correlation ID from request headers
 */
export declare function extractCorrelationId(headers: any): string | undefined;
//# sourceMappingURL=structured-logger.d.ts.map