/**
 * Math Validator - Validates numeric claims against ground truth from tool results
 */

import {
  NumericClaim,
  ValidationResult,
  ValidationSeverity,
  ToolResult,
  GroundTruth,
  GroundTruthStrategy,
  ValidationConfig,
  ClaimType,
} from './types/validation.types';
import { Logger } from './types';

/**
 * Default validation configuration
 */
const DEFAULT_CONFIG: ValidationConfig = {
  countTolerance: 0,
  percentageTolerance: 0.1,
  strictMode: true,
  autoCorrect: true,
  blockOnCritical: true,
  priorityWeights: {
    deviceCount: 10,
    uptime: 8,
    percentage: 7,
    streamAggregation: 5,
    other: 3,
  },
};

export class MathValidator {
  private logger: Logger;
  private config: ValidationConfig;
  private strategies: GroundTruthStrategy[];

  constructor(logger: Logger, config?: Partial<ValidationConfig>) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.strategies = this.initializeStrategies();
  }

  /**
   * Initialize ground truth extraction strategies
   */
  private initializeStrategies(): GroundTruthStrategy[] {
    return [
      // Strategy 1: Device count from list_devices
      {
        name: 'device_count_from_list_devices',
        applicableTools: ['list_devices'],
        applicableClaimTypes: ['count'],
        priority: 10,
        extract: (claim, toolResults) => {
          if (claim.entity !== 'device') return null;

          const deviceTools = toolResults.filter(r => r.toolName === 'list_devices');
          if (deviceTools.length === 0) return null;

          // Find the most relevant tool result based on filter
          const relevantTool = this.findRelevantDeviceTool(deviceTools, claim.filter);
          if (!relevantTool) return null;

          const data = this.parseToolContent(relevantTool);
          // DRM API returns paginated list: { "count": N, "list": [...] }
          if (!data || !Array.isArray(data.list)) return null;

          // If claim has a filter (connected, disconnected, etc.), filter the list
          let deviceList = data.list;
          if (claim.filter && claim.filter !== 'total') {
            deviceList = data.list.filter((device: any) =>
              device.connection_status === claim.filter
            );
          }

          return {
            source: 'list_devices',
            toolUseId: relevantTool.tool_use_id,
            path: claim.filter ? `list.filter(connection_status="${claim.filter}").length` : 'list.length',
            rawData: deviceList,
            extractionMethod: `Counted ${deviceList.length} devices with ${claim.filter ? `connection_status="${claim.filter}"` : 'no filter'} in list_devices result`,
          };
        },
      },

      // Strategy 2: Device count from connection report
      {
        name: 'device_count_from_connection_report',
        applicableTools: ['get_connection_report'],
        applicableClaimTypes: ['count', 'percentage'],
        priority: 9,
        extract: (claim, toolResults) => {
          if (claim.entity !== 'device') return null;

          const reportTool = toolResults.find(r => r.toolName === 'get_connection_report');
          if (!reportTool) return null;

          const data = this.parseToolContent(reportTool);
          if (!data) return null;

          let value: number | null = null;

          // DRM API returns nested objects: { "connected": { "count": 9 }, ... }
          if (claim.filter === 'connected') {
            value = data.connected?.count || null;
          } else if (claim.filter === 'disconnected') {
            value = data.disconnected?.count || null;
          } else if (claim.filter === 'never_connected') {
            value = data.never_connected?.count || null;
          } else if (claim.filter === 'total' || !claim.filter) {
            // Calculate total by summing all categories
            value = (data.connected?.count || 0) +
                    (data.disconnected?.count || 0) +
                    (data.never_connected?.count || 0);
          }

          if (value === null || value === 0) return null;

          return {
            source: 'get_connection_report',
            toolUseId: reportTool.tool_use_id,
            path: claim.filter ? `${claim.filter}.count` : 'total',
            rawData: data,
            extractionMethod: `Extracted ${claim.filter || 'total'} count from connection report`,
          };
        },
      },

      // Strategy 3: Uptime percentage from availability report
      {
        name: 'uptime_from_availability_report',
        applicableTools: ['get_device_availability_report'],
        applicableClaimTypes: ['percentage'],
        priority: 10,
        extract: (claim, toolResults) => {
          if (claim.filter !== 'uptime') return null;

          const reportTool = toolResults.find(r => r.toolName === 'get_device_availability_report');
          if (!reportTool) return null;

          const data = this.parseToolContent(reportTool);
          if (!data) return null;

          const uptimePercent = data.uptime_percent || data.availability_percent || null;
          if (uptimePercent === null) return null;

          return {
            source: 'get_device_availability_report',
            toolUseId: reportTool.tool_use_id,
            path: 'uptime_percent',
            rawData: data,
            extractionMethod: `Extracted uptime percentage from availability report`,
          };
        },
      },

      // Strategy 4: Stream aggregations from rollups
      {
        name: 'stream_aggregation_from_rollups',
        applicableTools: ['get_stream_rollups'],
        applicableClaimTypes: ['average', 'sum'],
        priority: 8,
        extract: (claim, toolResults) => {
          if (claim.entity !== 'stream') return null;

          const rollupTool = toolResults.find(r => r.toolName === 'get_stream_rollups');
          if (!rollupTool) return null;

          const data = this.parseToolContent(rollupTool);
          // DRM API returns paginated list: { "count": N, "list": [...] }
          if (!data || !Array.isArray(data.list)) return null;

          // Calculate the appropriate aggregation
          let value: number | null = null;

          if (claim.type === 'average') {
            const values = data.list.map((item: any) => parseFloat(item.value || item.avg || 0));
            value = values.reduce((a: number, b: number) => a + b, 0) / values.length;
          } else if (claim.type === 'sum') {
            value = data.list.reduce((sum: number, item: any) =>
              sum + parseFloat(item.value || item.sum || 0), 0
            );
          }

          if (value === null) return null;

          return {
            source: 'get_stream_rollups',
            toolUseId: rollupTool.tool_use_id,
            path: `list[].${claim.type}`,
            rawData: data.list,
            extractionMethod: `Calculated ${claim.type} from stream rollups`,
          };
        },
      },

      // Strategy 5: Alert counts from list_alerts
      {
        name: 'alert_count_from_list_alerts',
        applicableTools: ['list_alerts'],
        applicableClaimTypes: ['count'],
        priority: 9,
        extract: (claim, toolResults) => {
          if (claim.entity !== 'alert') return null;

          const alertTool = toolResults.find(r => r.toolName === 'list_alerts');
          if (!alertTool) return null;

          const data = this.parseToolContent(alertTool);
          // DRM API returns paginated list: { "count": N, "list": [...] }
          if (!data || !Array.isArray(data.list)) return null;

          return {
            source: 'list_alerts',
            toolUseId: alertTool.tool_use_id,
            path: 'list.length',
            rawData: data.list,
            extractionMethod: `Counted ${data.list.length} alerts in list_alerts result`,
          };
        },
      },
    ];
  }

  /**
   * Validate a single numeric claim
   */
  validate(claim: NumericClaim, toolResults: ToolResult[]): ValidationResult {
    // Find applicable strategies
    const applicableStrategies = this.strategies
      .filter(s =>
        s.applicableClaimTypes.includes(claim.type) &&
        toolResults.some(tr => s.applicableTools.includes(tr.toolName))
      )
      .sort((a, b) => b.priority - a.priority);

    let groundTruth: GroundTruth | null = null;
    let actualValue: number | null = null;

    // Try each strategy until we get ground truth
    for (const strategy of applicableStrategies) {
      groundTruth = strategy.extract(claim, toolResults);
      if (groundTruth) {
        actualValue = this.extractValueFromGroundTruth(groundTruth);
        this.logger.debug('Ground truth found', {
          strategy: strategy.name,
          claimType: claim.type,
          claimValue: claim.value,
          actualValue,
        });
        break;
      }
    }

    // If no ground truth found, cannot validate
    if (groundTruth === null || actualValue === null) {
      return {
        claim,
        isValid: true, // Assume valid if we can't verify
        actualValue: null,
        claimedValue: claim.value,
        error: null,
        errorPercent: null,
        severity: 'none',
        groundTruth: null,
        validationMethod: 'no_ground_truth_available',
      };
    }

    // Compare claimed vs actual
    const error = Math.abs(claim.value - actualValue);
    const errorPercent = actualValue !== 0 ? (error / actualValue) * 100 : 0;

    const isValid = this.isWithinTolerance(claim.type, error, errorPercent);
    const severity = this.calculateSeverity(claim, error, errorPercent);

    const result: ValidationResult = {
      claim,
      isValid,
      actualValue,
      claimedValue: claim.value,
      error,
      errorPercent,
      severity,
      groundTruth,
      validationMethod: `validated_against_${groundTruth.source}`,
    };

    if (!isValid) {
      this.logger.warn('Validation failed', {
        claim: claim.rawText,
        claimedValue: claim.value,
        actualValue,
        error,
        errorPercent: errorPercent.toFixed(2) + '%',
        severity,
      });
    }

    return result;
  }

  /**
   * Validate all claims in a parsed response
   */
  validateAll(claims: NumericClaim[], toolResults: ToolResult[]): ValidationResult[] {
    return claims.map(claim => this.validate(claim, toolResults));
  }

  /**
   * Check if error is within acceptable tolerance
   */
  private isWithinTolerance(claimType: ClaimType, error: number, errorPercent: number): boolean {
    if (claimType === 'count') {
      return error <= this.config.countTolerance;
    } else if (claimType === 'percentage') {
      return error <= this.config.percentageTolerance;
    } else {
      // For other types, use percentage tolerance
      return errorPercent <= this.config.percentageTolerance;
    }
  }

  /**
   * Calculate severity of validation error
   */
  private calculateSeverity(claim: NumericClaim, error: number, errorPercent: number): ValidationSeverity {
    // Critical: Device counts (highest priority), large errors
    if (claim.entity === 'device' && claim.type === 'count') {
      if (error > 0) return 'critical'; // Any device count error is critical
    }

    // Major: Uptime calculations, significant percentage errors
    if (claim.filter === 'uptime' || (claim.type === 'percentage' && errorPercent > 5)) {
      return 'major';
    }

    // Major: Large count errors (>10% off)
    if (claim.type === 'count' && errorPercent > 10) {
      return 'major';
    }

    // Minor: Small errors
    if (errorPercent > 1) {
      return 'minor';
    }

    return 'none';
  }

  /**
   * Extract numeric value from ground truth
   */
  private extractValueFromGroundTruth(groundTruth: GroundTruth): number | null {
    if (Array.isArray(groundTruth.rawData)) {
      return groundTruth.rawData.length;
    }

    if (typeof groundTruth.rawData === 'number') {
      return groundTruth.rawData;
    }

    if (typeof groundTruth.rawData === 'object' && groundTruth.rawData !== null) {
      // Try to extract value from path
      const pathParts = groundTruth.path.split('.');
      let value: any = groundTruth.rawData;

      for (const part of pathParts) {
        if (part === 'length' && Array.isArray(value)) {
          value = value.length;
        } else if (value && typeof value === 'object' && part in value) {
          value = value[part];
        } else {
          return null;
        }
      }

      if (typeof value === 'number') {
        return value;
      }
    }

    return null;
  }

  /**
   * Parse tool content JSON
   */
  private parseToolContent(toolResult: ToolResult): any {
    if (toolResult.parsedContent) {
      return toolResult.parsedContent;
    }

    // Don't attempt to parse error results - they contain plain text error messages, not JSON
    if (toolResult.is_error) {
      return null;
    }

    try {
      const parsed = JSON.parse(toolResult.content);
      toolResult.parsedContent = parsed; // Cache it
      return parsed;
    } catch (error) {
      // Only log parsing errors for non-error results (unexpected JSON format)
      this.logger.error('Failed to parse tool content', {
        toolName: toolResult.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Find the most relevant device tool based on filter
   */
  private findRelevantDeviceTool(deviceTools: ToolResult[], filter?: string): ToolResult | null {
    if (!filter) {
      // Return the most recent one
      return deviceTools[deviceTools.length - 1];
    }

    // Look for a tool that was queried with the matching filter
    for (const tool of deviceTools.reverse()) {
      const data = this.parseToolContent(tool);
      if (!data) continue;

      // Check if the query parameter matches the filter
      if (data.query && typeof data.query === 'string') {
        const query = data.query.toLowerCase();
        if (query.includes(`connection_status="${filter}"`) ||
            query.includes(`connection_status='${filter}'`)) {
          return tool;
        }
      }

      // If no explicit query, check if all items match the filter
      // DRM API returns paginated list: { "count": N, "list": [...] }
      if (Array.isArray(data.list) && data.list.length > 0) {
        const firstItem = data.list[0];
        if (firstItem.connection_status === filter) {
          return tool;
        }
      }
    }

    // Fallback to most recent
    return deviceTools[deviceTools.length - 1];
  }
}
