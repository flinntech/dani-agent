"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSecrets = loadSecrets;
exports.clearSecretsCache = clearSecretsCache;
exports.getSecret = getSecret;
exports.isRunningInAWS = isRunningInAWS;
exports.getECSTaskId = getECSTaskId;
exports.getECSContainerName = getECSContainerName;
exports.logEnvironmentInfo = logEnvironmentInfo;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
// Configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'dani/prod';
const USE_SECRETS_MANAGER = process.env.USE_SECRETS_MANAGER !== 'false'; // Default to true in production
// Secret mapping: environment variable name => Secrets Manager secret name
const SECRET_MAPPINGS = {
    // Database
    DB_PASSWORD: `${SECRET_PREFIX}/database/password`,
    POSTGRES_PASSWORD: `${SECRET_PREFIX}/database/password`,
    // Application Security
    JWT_SECRET: `${SECRET_PREFIX}/jwt/secret`,
    SESSION_SECRET: `${SECRET_PREFIX}/session/secret`,
    ENCRYPTION_KEY: `${SECRET_PREFIX}/encryption/key`,
    // AI Provider
    ANTHROPIC_API_KEY: `${SECRET_PREFIX}/anthropic/api-key`,
    // External APIs
    DRM_API_KEY_ID: `${SECRET_PREFIX}/drm/api-key-id`,
    DRM_API_KEY_SECRET: `${SECRET_PREFIX}/drm/api-key-secret`,
    STATUSGATOR_API_KEY: `${SECRET_PREFIX}/statusgator/api-key`,
};
// In-memory cache of loaded secrets
let secretsCache = null;
let isLoading = false;
/**
 * Load a single secret from AWS Secrets Manager
 */
async function loadSecret(client, secretName) {
    try {
        const command = new client_secrets_manager_1.GetSecretValueCommand({
            SecretId: secretName,
        });
        const response = await client.send(command);
        if (response.SecretString) {
            return response.SecretString;
        }
        console.warn(`[Secrets] Secret ${secretName} has no string value`);
        return null;
    }
    catch (error) {
        if (error instanceof client_secrets_manager_1.SecretsManagerServiceException) {
            if (error.name === 'ResourceNotFoundException') {
                console.warn(`[Secrets] Secret not found: ${secretName}`);
                return null;
            }
            console.error(`[Secrets] Error loading ${secretName}:`, error.message);
        }
        else {
            console.error(`[Secrets] Unexpected error loading ${secretName}:`, error);
        }
        return null;
    }
}
/**
 * Load all secrets from AWS Secrets Manager
 *
 * @returns Object with environment variable names as keys and secret values
 */
async function loadSecrets() {
    // Return cached secrets if already loaded
    if (secretsCache) {
        console.log('[Secrets] Using cached secrets');
        return secretsCache;
    }
    // Prevent concurrent loading
    if (isLoading) {
        console.log('[Secrets] Already loading secrets, waiting...');
        // Wait for loading to complete (simple polling)
        while (isLoading) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return secretsCache || {};
    }
    isLoading = true;
    const secrets = {};
    try {
        // Check if we should use Secrets Manager (production) or environment variables (local dev)
        if (!USE_SECRETS_MANAGER) {
            console.log('[Secrets] Using environment variables (local development mode)');
            // Load from environment variables
            for (const envVar of Object.keys(SECRET_MAPPINGS)) {
                const value = process.env[envVar];
                if (value) {
                    secrets[envVar] = value;
                }
            }
            secretsCache = secrets;
            return secrets;
        }
        console.log(`[Secrets] Loading secrets from AWS Secrets Manager (region: ${AWS_REGION})`);
        // Create Secrets Manager client
        const client = new client_secrets_manager_1.SecretsManagerClient({
            region: AWS_REGION,
        });
        // Load all secrets in parallel
        const loadPromises = Object.entries(SECRET_MAPPINGS).map(async ([envVar, secretName]) => {
            const value = await loadSecret(client, secretName);
            if (value) {
                secrets[envVar] = value;
                console.log(`[Secrets] ✓ Loaded: ${envVar}`);
            }
            else {
                // Fall back to environment variable if secret not found
                const envValue = process.env[envVar];
                if (envValue) {
                    secrets[envVar] = envValue;
                    console.log(`[Secrets] ⚠ Using env var for: ${envVar} (secret not found)`);
                }
                else {
                    console.warn(`[Secrets] ✗ Missing: ${envVar} (not in Secrets Manager or env vars)`);
                }
            }
        });
        await Promise.all(loadPromises);
        console.log(`[Secrets] Loaded ${Object.keys(secrets).length} secrets`);
        secretsCache = secrets;
    }
    catch (error) {
        console.error('[Secrets] Fatal error loading secrets:', error);
        // Fall back to environment variables on error
        console.warn('[Secrets] Falling back to environment variables due to error');
        for (const envVar of Object.keys(SECRET_MAPPINGS)) {
            const value = process.env[envVar];
            if (value) {
                secrets[envVar] = value;
            }
        }
        secretsCache = secrets;
    }
    finally {
        isLoading = false;
    }
    return secrets;
}
/**
 * Clear the secrets cache
 * Useful for testing or if secrets need to be reloaded
 */
function clearSecretsCache() {
    secretsCache = null;
    console.log('[Secrets] Cache cleared');
}
/**
 * Get a single secret value
 * Loads all secrets if not already cached
 */
async function getSecret(key) {
    const secrets = await loadSecrets();
    return secrets[key];
}
/**
 * Check if running in AWS (ECS)
 * Based on common ECS environment variables
 */
function isRunningInAWS() {
    return !!(process.env.ECS_CONTAINER_METADATA_URI ||
        process.env.ECS_CONTAINER_METADATA_URI_V4 ||
        process.env.AWS_EXECUTION_ENV);
}
/**
 * Get the ECS task ID if running in ECS
 */
function getECSTaskId() {
    const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (metadataUri) {
        // Extract task ID from metadata URI
        // Format: http://169.254.170.2/v4/<task-id>
        const match = metadataUri.match(/\/v4\/([^/]+)/);
        return match ? match[1] : undefined;
    }
    return undefined;
}
/**
 * Get the ECS container name if running in ECS
 */
function getECSContainerName() {
    return process.env.ECS_CONTAINER_NAME;
}
/**
 * Log startup information about the environment
 */
function logEnvironmentInfo() {
    console.log('[Environment] Startup Information:');
    console.log(`  Node Version: ${process.version}`);
    console.log(`  Platform: ${process.platform}`);
    console.log(`  AWS Region: ${AWS_REGION}`);
    console.log(`  Running in AWS: ${isRunningInAWS()}`);
    console.log(`  Use Secrets Manager: ${USE_SECRETS_MANAGER}`);
    if (isRunningInAWS()) {
        const taskId = getECSTaskId();
        const containerName = getECSContainerName();
        console.log(`  ECS Task ID: ${taskId || 'unknown'}`);
        console.log(`  ECS Container: ${containerName || 'unknown'}`);
    }
}
//# sourceMappingURL=secrets-loader.js.map