/**
 * Response Corrector - Automatically fixes mathematical errors in responses
 */

import {
  ParsedResponse,
  ValidationResult,
  CorrectionAction,
  CorrectedResponse,
  ToolResult,
  ExtractedList,
  ValidationSeverity,
} from './types/validation.types';
import { Logger } from './types';

export class ResponseCorrector {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Correct all errors in a response
   */
  correctResponse(
    parsed: ParsedResponse,
    validations: ValidationResult[],
    toolResults: ToolResult[]
  ): CorrectedResponse {
    const corrections: CorrectionAction[] = [];
    let correctedText = parsed.originalText;

    // Get failed validations sorted by severity
    const failures = validations
      .filter(v => !v.isValid)
      .sort((a, b) => this.severityWeight(b.severity) - this.severityWeight(a.severity));

    if (failures.length === 0) {
      return {
        text: correctedText,
        correctionsMade: false,
        corrections: [],
        severity: 'none',
        validationResults: validations,
        metadata: {
          originalLength: parsed.originalText.length,
          correctedLength: parsed.originalText.length,
          claimsValidated: validations.length,
          claimsCorrected: 0,
          listsValidated: parsed.lists.length,
          listsCorrected: 0,
        },
      };
    }

    this.logger.info('Correcting response', {
      failureCount: failures.length,
      severities: failures.map(f => f.severity),
    });

    // Priority 1: Fix device count/list mismatches (critical)
    const deviceCountCorrections = this.fixDeviceCountMismatches(
      parsed,
      failures.filter(f => f.claim.entity === 'device' && f.claim.type === 'count'),
      toolResults
    );
    corrections.push(...deviceCountCorrections);

    // Priority 2: Fix other count errors
    const otherCountCorrections = this.fixCountErrors(
      failures.filter(f => f.claim.entity !== 'device' && f.claim.type === 'count')
    );
    corrections.push(...otherCountCorrections);

    // Priority 3: Fix percentage errors
    const percentageCorrections = this.fixPercentageErrors(
      failures.filter(f => f.claim.type === 'percentage')
    );
    corrections.push(...percentageCorrections);

    // Priority 4: Fix uptime calculations
    const uptimeCorrections = this.fixUptimeErrors(
      failures.filter(f => f.claim.filter === 'uptime')
    );
    corrections.push(...uptimeCorrections);

    // Priority 5: Fix stream aggregations
    const streamCorrections = this.fixStreamAggregationErrors(
      failures.filter(f => f.claim.entity === 'stream')
    );
    corrections.push(...streamCorrections);

    // Apply all corrections (in reverse order to maintain indices)
    corrections.sort((a, b) => b.location.start - a.location.start);

    for (const correction of corrections) {
      correctedText =
        correctedText.substring(0, correction.location.start) +
        correction.corrected +
        correctedText.substring(correction.location.end);
    }

    const maxSeverity = this.getMaxSeverity(corrections);

    return {
      text: correctedText,
      correctionsMade: true,
      corrections,
      severity: maxSeverity,
      validationResults: validations,
      metadata: {
        originalLength: parsed.originalText.length,
        correctedLength: correctedText.length,
        claimsValidated: validations.length,
        claimsCorrected: corrections.length,
        listsValidated: parsed.lists.length,
        listsCorrected: corrections.filter(c => c.type === 'truncate' || c.type === 'regenerate').length,
      },
    };
  }

  /**
   * Fix device count mismatches (highest priority)
   */
  private fixDeviceCountMismatches(
    parsed: ParsedResponse,
    deviceCountFailures: ValidationResult[],
    toolResults: ToolResult[]
  ): CorrectionAction[] {
    const corrections: CorrectionAction[] = [];

    for (const failure of deviceCountFailures) {
      const claim = failure.claim;
      const actualValue = failure.actualValue;

      if (actualValue === null) continue;

      // Step 1: Fix the count claim itself
      const countCorrection: CorrectionAction = {
        type: 'replace',
        location: {
          start: claim.startIndex,
          end: claim.endIndex,
        },
        original: claim.rawText,
        corrected: claim.rawText.replace(claim.value.toString(), actualValue.toString()),
        reason: `Device count was ${claim.value}, actual count is ${actualValue}`,
        severity: failure.severity,
        relatedClaim: claim,
      };
      corrections.push(countCorrection);

      // Step 2: Find and fix associated list (if any)
      const relatedList = parsed.lists.find(list =>
        list.type === 'device' &&
        Math.abs(list.startIndex - claim.startIndex) < 500
      );

      if (relatedList && relatedList.itemCount !== actualValue) {
        const listCorrection = this.fixDeviceList(relatedList, actualValue, toolResults, failure);
        if (listCorrection) {
          corrections.push(listCorrection);
        }
      }
    }

    return corrections;
  }

  /**
   * Fix a device list to match the correct count
   */
  private fixDeviceList(
    list: ExtractedList,
    correctCount: number,
    _toolResults: ToolResult[],
    validation: ValidationResult
  ): CorrectionAction | null {
    if (!validation.groundTruth) return null;

    // Get the actual device list from ground truth
    const deviceData = validation.groundTruth.rawData;
    if (!Array.isArray(deviceData)) return null;

    // Take first N devices from ground truth
    const correctDevices = deviceData.slice(0, correctCount);

    // Format device list
    const formattedList = correctDevices
      .map((device: any, index: number) => {
        const name = device.name || device.devConnectwareId || device.id || `Device ${index + 1}`;
        const type = device.dpDeviceType || device.device_type || '';
        const lastConnect = device.dpLastConnectTime || device.last_connect || '';

        let line = `${index + 1}. ${name}`;
        if (type) line += ` (${type})`;
        if (lastConnect) {
          const date = new Date(lastConnect);
          line += ` - Last connected: ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        return line;
      })
      .join('\n');

    return {
      type: 'regenerate',
      location: {
        start: list.startIndex + (list.headerText?.length || 0),
        end: list.endIndex,
      },
      original: `Listed ${list.itemCount} devices`,
      corrected: '\n' + formattedList,
      reason: `Device list had ${list.itemCount} items, but actual count is ${correctCount}. Regenerated list from tool results.`,
      severity: 'critical',
      relatedList: list,
    };
  }

  /**
   * Fix general count errors
   */
  private fixCountErrors(failures: ValidationResult[]): CorrectionAction[] {
    return failures.map(failure => {
      const claim = failure.claim;
      const actualValue = failure.actualValue;

      if (actualValue === null) {
        return {
          type: 'remove',
          location: { start: claim.startIndex, end: claim.endIndex },
          original: claim.rawText,
          corrected: '[count unavailable]',
          reason: 'Could not verify count from tool results',
          severity: failure.severity,
          relatedClaim: claim,
        };
      }

      return {
        type: 'replace',
        location: { start: claim.startIndex, end: claim.endIndex },
        original: claim.rawText,
        corrected: claim.rawText.replace(claim.value.toString(), actualValue.toString()),
        reason: `Claimed ${claim.value}, actual value is ${actualValue}`,
        severity: failure.severity,
        relatedClaim: claim,
      };
    });
  }

  /**
   * Fix percentage errors
   */
  private fixPercentageErrors(failures: ValidationResult[]): CorrectionAction[] {
    return failures.map(failure => {
      const claim = failure.claim;
      const actualValue = failure.actualValue;

      if (actualValue === null) {
        return {
          type: 'remove',
          location: { start: claim.startIndex, end: claim.endIndex },
          original: claim.rawText,
          corrected: '[percentage unavailable]',
          reason: 'Could not verify percentage from tool results',
          severity: failure.severity,
          relatedClaim: claim,
        };
      }

      // Format percentage to 1 decimal place
      const formattedValue = actualValue.toFixed(1);

      return {
        type: 'replace',
        location: { start: claim.startIndex, end: claim.endIndex },
        original: claim.rawText,
        corrected: claim.rawText.replace(
          claim.value.toString(),
          formattedValue
        ),
        reason: `Percentage was ${claim.value}%, actual is ${formattedValue}%`,
        severity: failure.severity,
        relatedClaim: claim,
      };
    });
  }

  /**
   * Fix uptime calculation errors
   */
  private fixUptimeErrors(failures: ValidationResult[]): CorrectionAction[] {
    return failures.map(failure => {
      const claim = failure.claim;
      const actualValue = failure.actualValue;

      if (actualValue === null) {
        return {
          type: 'remove',
          location: { start: claim.startIndex, end: claim.endIndex },
          original: claim.rawText,
          corrected: '[uptime unavailable]',
          reason: 'Could not verify uptime from tool results',
          severity: failure.severity,
          relatedClaim: claim,
        };
      }

      const formattedValue = actualValue.toFixed(1);

      return {
        type: 'replace',
        location: { start: claim.startIndex, end: claim.endIndex },
        original: claim.rawText,
        corrected: claim.rawText.replace(
          claim.value.toString() + '%',
          formattedValue + '%'
        ),
        reason: `Uptime was ${claim.value}%, actual is ${formattedValue}%`,
        severity: failure.severity,
        relatedClaim: claim,
      };
    });
  }

  /**
   * Fix stream aggregation errors
   */
  private fixStreamAggregationErrors(failures: ValidationResult[]): CorrectionAction[] {
    return failures.map(failure => {
      const claim = failure.claim;
      const actualValue = failure.actualValue;

      if (actualValue === null) {
        return {
          type: 'remove',
          location: { start: claim.startIndex, end: claim.endIndex },
          original: claim.rawText,
          corrected: `[${claim.type} unavailable]`,
          reason: `Could not verify ${claim.type} from tool results`,
          severity: failure.severity,
        };
      }

      const formattedValue = actualValue.toFixed(2);

      return {
        type: 'replace',
        location: { start: claim.startIndex, end: claim.endIndex },
        original: claim.rawText,
        corrected: claim.rawText.replace(
          claim.value.toString(),
          formattedValue
        ),
        reason: `${claim.type} was ${claim.value}, actual is ${formattedValue}`,
        severity: failure.severity,
      };
    });
  }

  /**
   * Get maximum severity from corrections
   */
  private getMaxSeverity(corrections: CorrectionAction[]): ValidationSeverity {
    if (corrections.length === 0) return 'none';

    const severities = corrections.map(c => c.severity);
    if (severities.includes('critical')) return 'critical';
    if (severities.includes('major')) return 'major';
    if (severities.includes('minor')) return 'minor';
    return 'none';
  }

  /**
   * Get numeric weight for severity (for sorting)
   */
  private severityWeight(severity: ValidationSeverity): number {
    switch (severity) {
      case 'critical': return 4;
      case 'major': return 3;
      case 'minor': return 2;
      case 'none': return 1;
    }
  }
}
