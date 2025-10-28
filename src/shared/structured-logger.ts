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

  // Performance metrics
  durationMs?: number;
  operation?: string;

  // Request metadata
  method?: string;
  path?: string;
  statusCode?: number;
  ip?: string;

  // Error context
  error?: Error | string;
  stackTrace?: string;

  // Custom fields
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context: LogContext;

  // ECS metadata (auto-populated in AWS)
  ecsTaskId?: string;
  ecsContainerName?: string;
  ecsTaskDefinition?: string;

  // AWS region
  awsRegion?: string;
}

/**
 * Structured Logger Class
 */
export class StructuredLogger {
  private serviceName: string;
  private minLevel: LogLevel;
  private ecsMetadata: {
    taskId?: string;
    containerName?: string;
    taskDefinition?: string;
  };

  constructor(serviceName: string, minLevel: LogLevel = 'info') {
    this.serviceName = serviceName;
    this.minLevel = minLevel;
    this.ecsMetadata = this.loadECSMetadata();
  }

  /**
   * Load ECS metadata from environment
   */
  private loadECSMetadata() {
    return {
      taskId: this.getECSTaskId(),
      containerName: process.env.ECS_CONTAINER_METADATA_URI_V4 ?
        process.env.HOSTNAME : undefined,
      taskDefinition: process.env.ECS_TASK_DEFINITION,
    };
  }

  /**
   * Extract ECS task ID from metadata
   */
  private getECSTaskId(): string | undefined {
    const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (!metadataUri) return undefined;

    // Task ID is typically in the metadata URI path
    const match = metadataUri.match(/\/task\/([a-f0-9-]+)/i);
    return match ? match[1] : undefined;
  }

  /**
   * Check if log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const minLevelIndex = levels.indexOf(this.minLevel);
    const currentLevelIndex = levels.indexOf(level);
    return currentLevelIndex >= minLevelIndex;
  }

  /**
   * Create a log entry
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    context: LogContext = {}
  ): LogEntry {
    // Process error if present
    if (context.error) {
      if (context.error instanceof Error) {
        context.stackTrace = context.error.stack;
        context.error = context.error.message;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      context,
      ecsTaskId: this.ecsMetadata.taskId,
      ecsContainerName: this.ecsMetadata.containerName,
      ecsTaskDefinition: this.ecsMetadata.taskDefinition,
      awsRegion: process.env.AWS_REGION,
    };
  }

  /**
   * Output log entry
   */
  private log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    // Output as JSON for CloudWatch
    const output = JSON.stringify(entry);

    // Use appropriate console method
    switch (entry.level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'debug':
        console.debug(output);
        break;
      default:
        console.log(output);
    }
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: LogContext): void {
    this.log(this.createLogEntry('debug', message, context));
  }

  /**
   * Log info message
   */
  info(message: string, context?: LogContext): void {
    this.log(this.createLogEntry('info', message, context));
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: LogContext): void {
    this.log(this.createLogEntry('warn', message, context));
  }

  /**
   * Log error message
   */
  error(message: string, context?: LogContext): void {
    this.log(this.createLogEntry('error', message, context));
  }

  /**
   * Create a child logger with pre-populated context
   * Useful for adding request-specific context to all logs
   */
  child(additionalContext: LogContext): StructuredLogger {
    const childLogger = new StructuredLogger(this.serviceName, this.minLevel);

    // Override log method to merge context
    const originalLog = childLogger.log.bind(childLogger);
    childLogger.log = (entry: LogEntry) => {
      entry.context = { ...additionalContext, ...entry.context };
      originalLog(entry);
    };

    return childLogger;
  }

  /**
   * Time an async operation and log performance
   */
  async timeAsync<T>(
    operation: string,
    fn: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;

      this.info(`${operation} completed`, {
        ...context,
        operation,
        durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      this.error(`${operation} failed`, {
        ...context,
        operation,
        durationMs,
        error: error as Error,
      });

      throw error;
    }
  }

  /**
   * Time a sync operation and log performance
   */
  time<T>(
    operation: string,
    fn: () => T,
    context?: LogContext
  ): T {
    const startTime = Date.now();

    try {
      const result = fn();
      const durationMs = Date.now() - startTime;

      this.info(`${operation} completed`, {
        ...context,
        operation,
        durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      this.error(`${operation} failed`, {
        ...context,
        operation,
        durationMs,
        error: error as Error,
      });

      throw error;
    }
  }
}

/**
 * Helper: Generate correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Helper: Extract correlation ID from request headers
 */
export function extractCorrelationId(headers: any): string | undefined {
  return headers['x-correlation-id'] ||
         headers['x-request-id'] ||
         headers['x-amzn-trace-id'];
}
