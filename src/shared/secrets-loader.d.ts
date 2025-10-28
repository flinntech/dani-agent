/**
 * AWS Secrets Manager Loader Utility
 *
 * This utility loads secrets from AWS Secrets Manager at application startup.
 * Falls back to environment variables for local development.
 * Caches secrets in memory to avoid repeated AWS API calls.
 *
 * Usage:
 *
 * ```typescript
 * import { loadSecrets } from './shared/secrets-loader';
 *
 * // At application startup
 * const secrets = await loadSecrets();
 *
 * // Access secrets
 * const dbPassword = secrets.DB_PASSWORD;
 * const apiKey = secrets.ANTHROPIC_API_KEY;
 * ```
 */
/**
 * Load all secrets from AWS Secrets Manager
 *
 * @returns Object with environment variable names as keys and secret values
 */
export declare function loadSecrets(): Promise<Record<string, string>>;
/**
 * Clear the secrets cache
 * Useful for testing or if secrets need to be reloaded
 */
export declare function clearSecretsCache(): void;
/**
 * Get a single secret value
 * Loads all secrets if not already cached
 */
export declare function getSecret(key: string): Promise<string | undefined>;
/**
 * Check if running in AWS (ECS)
 * Based on common ECS environment variables
 */
export declare function isRunningInAWS(): boolean;
/**
 * Get the ECS task ID if running in ECS
 */
export declare function getECSTaskId(): string | undefined;
/**
 * Get the ECS container name if running in ECS
 */
export declare function getECSContainerName(): string | undefined;
/**
 * Log startup information about the environment
 */
export declare function logEnvironmentInfo(): void;
//# sourceMappingURL=secrets-loader.d.ts.map