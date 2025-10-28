"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StructuredLogger = void 0;
exports.generateCorrelationId = generateCorrelationId;
exports.extractCorrelationId = extractCorrelationId;
/**
 * Structured Logger Class
 */
class StructuredLogger {
    serviceName;
    minLevel;
    ecsMetadata;
    constructor(serviceName, minLevel = 'info') {
        this.serviceName = serviceName;
        this.minLevel = minLevel;
        this.ecsMetadata = this.loadECSMetadata();
    }
    /**
     * Load ECS metadata from environment
     */
    loadECSMetadata() {
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
    getECSTaskId() {
        const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
        if (!metadataUri)
            return undefined;
        // Task ID is typically in the metadata URI path
        const match = metadataUri.match(/\/task\/([a-f0-9-]+)/i);
        return match ? match[1] : undefined;
    }
    /**
     * Check if log level should be output
     */
    shouldLog(level) {
        const levels = ['debug', 'info', 'warn', 'error'];
        const minLevelIndex = levels.indexOf(this.minLevel);
        const currentLevelIndex = levels.indexOf(level);
        return currentLevelIndex >= minLevelIndex;
    }
    /**
     * Create a log entry
     */
    createLogEntry(level, message, context = {}) {
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
    log(entry) {
        if (!this.shouldLog(entry.level))
            return;
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
    debug(message, context) {
        this.log(this.createLogEntry('debug', message, context));
    }
    /**
     * Log info message
     */
    info(message, context) {
        this.log(this.createLogEntry('info', message, context));
    }
    /**
     * Log warning message
     */
    warn(message, context) {
        this.log(this.createLogEntry('warn', message, context));
    }
    /**
     * Log error message
     */
    error(message, context) {
        this.log(this.createLogEntry('error', message, context));
    }
    /**
     * Create a child logger with pre-populated context
     * Useful for adding request-specific context to all logs
     */
    child(additionalContext) {
        const childLogger = new StructuredLogger(this.serviceName, this.minLevel);
        // Override log method to merge context
        const originalLog = childLogger.log.bind(childLogger);
        childLogger.log = (entry) => {
            entry.context = { ...additionalContext, ...entry.context };
            originalLog(entry);
        };
        return childLogger;
    }
    /**
     * Time an async operation and log performance
     */
    async timeAsync(operation, fn, context) {
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
        }
        catch (error) {
            const durationMs = Date.now() - startTime;
            this.error(`${operation} failed`, {
                ...context,
                operation,
                durationMs,
                error: error,
            });
            throw error;
        }
    }
    /**
     * Time a sync operation and log performance
     */
    time(operation, fn, context) {
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
        }
        catch (error) {
            const durationMs = Date.now() - startTime;
            this.error(`${operation} failed`, {
                ...context,
                operation,
                durationMs,
                error: error,
            });
            throw error;
        }
    }
}
exports.StructuredLogger = StructuredLogger;
/**
 * Helper: Generate correlation ID for request tracing
 */
function generateCorrelationId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
/**
 * Helper: Extract correlation ID from request headers
 */
function extractCorrelationId(headers) {
    return headers['x-correlation-id'] ||
        headers['x-request-id'] ||
        headers['x-amzn-trace-id'];
}
//# sourceMappingURL=structured-logger.js.map