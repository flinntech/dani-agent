/**
 * Traced HTTP Client
 *
 * HTTP client wrapper that automatically:
 * - Propagates correlation IDs across service calls
 * - Logs all requests and responses
 * - Times all operations
 * - Provides structured error logging
 *
 * Use this instead of raw fetch/axios for service-to-service calls.
 */

import { StructuredLogger, LogContext } from './structured-logger';

export interface TracedRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  correlationId?: string;
}

export interface TracedResponse<T = any> {
  data: T;
  status: number;
  headers: Record<string, string>;
  durationMs: number;
}

/**
 * Traced HTTP Client
 *
 * Usage:
 * ```typescript
 * const client = new TracedHttpClient(logger, 'agent-to-mcp');
 *
 * // Make a request (automatically logs and times it)
 * const response = await client.request<ChatResponse>('http://localhost:8080/chat', {
 *   method: 'POST',
 *   body: { message: 'Hello' },
 *   correlationId: req.correlationId, // Propagates correlation ID
 * });
 * ```
 */
export class TracedHttpClient {
  private logger: StructuredLogger;
  private clientName: string;

  constructor(logger: StructuredLogger, clientName: string) {
    this.logger = logger;
    this.clientName = clientName;
  }

  /**
   * Make an HTTP request with tracing
   */
  async request<T = any>(
    url: string,
    options: TracedRequestOptions = {}
  ): Promise<TracedResponse<T>> {
    const {
      method = 'GET',
      headers = {},
      body,
      timeout = 30000,
      correlationId,
    } = options;

    const startTime = Date.now();

    // Add correlation ID to headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (correlationId) {
      requestHeaders['X-Correlation-ID'] = correlationId;
      requestHeaders['X-Request-ID'] = correlationId;
    }

    const logContext: LogContext = {
      requestId: correlationId,
      operation: `HTTP ${method}`,
      url,
      client: this.clientName,
    };

    this.logger.debug(`${this.clientName}: Sending ${method} request`, {
      ...logContext,
      body: body ? this.sanitizeBody(body) : undefined,
    });

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const fetchOptions: RequestInit = {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      };

      // Make request
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const durationMs = Date.now() - startTime;

      // Read response
      let data: T;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as unknown as T;
      }

      // Extract response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Log response
      if (response.ok) {
        this.logger.info(`${this.clientName}: Request completed`, {
          ...logContext,
          statusCode: response.status,
          durationMs,
        });
      } else {
        this.logger.warn(`${this.clientName}: Request failed`, {
          ...logContext,
          statusCode: response.status,
          durationMs,
          responseBody: data,
        });
      }

      return {
        data,
        status: response.status,
        headers: responseHeaders,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Handle timeout specifically
      const isTimeout = error instanceof Error && error.name === 'AbortError';

      this.logger.error(
        `${this.clientName}: Request error${isTimeout ? ' (timeout)' : ''}`,
        {
          ...logContext,
          durationMs,
          timeout: isTimeout ? timeout : undefined,
          error: error as Error,
        }
      );

      throw error;
    }
  }

  /**
   * Convenience method for GET requests
   */
  async get<T = any>(url: string, correlationId?: string): Promise<TracedResponse<T>> {
    return this.request<T>(url, { method: 'GET', correlationId });
  }

  /**
   * Convenience method for POST requests
   */
  async post<T = any>(
    url: string,
    body: any,
    correlationId?: string
  ): Promise<TracedResponse<T>> {
    return this.request<T>(url, { method: 'POST', body, correlationId });
  }

  /**
   * Convenience method for PUT requests
   */
  async put<T = any>(
    url: string,
    body: any,
    correlationId?: string
  ): Promise<TracedResponse<T>> {
    return this.request<T>(url, { method: 'PUT', body, correlationId });
  }

  /**
   * Convenience method for DELETE requests
   */
  async delete<T = any>(url: string, correlationId?: string): Promise<TracedResponse<T>> {
    return this.request<T>(url, { method: 'DELETE', correlationId });
  }

  /**
   * Sanitize request body for logging (remove sensitive fields)
   */
  private sanitizeBody(body: any): any {
    if (typeof body !== 'object' || body === null) {
      return body;
    }

    const sanitized = { ...body };
    const sensitiveFields = [
      'password',
      'apiKey',
      'api_key',
      'secret',
      'token',
      'authorization',
      'drmApiKeys',
    ];

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }
}
