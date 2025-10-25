/**
 * Type definitions for math validation and auto-correction system
 */

/**
 * Types of numeric claims that can be extracted from responses
 */
export type ClaimType = 'count' | 'percentage' | 'average' | 'sum' | 'duration' | 'ratio';

/**
 * Entity types that claims can reference
 */
export type EntityType = 'device' | 'stream' | 'alert' | 'group' | 'job' | 'firmware' | 'other';

/**
 * A numeric claim extracted from Claude's response
 */
export interface NumericClaim {
  type: ClaimType;
  entity: EntityType;
  value: number;
  context: string; // Surrounding text for context
  lineNumber: number;
  startIndex: number; // Character position in original text
  endIndex: number;
  filter?: string; // e.g., "connected", "disconnected", "error"
  rawText: string; // Original text like "Connected devices: 8"
}

/**
 * A list of items extracted from the response
 */
export interface ExtractedList {
  type: EntityType;
  items: string[];
  itemCount: number;
  claimedCount?: number; // If response explicitly states count
  startIndex: number;
  endIndex: number;
  headerText?: string; // e.g., "Currently Online Devices:"
}

/**
 * Parsed response structure
 */
export interface ParsedResponse {
  originalText: string;
  claims: NumericClaim[];
  lists: ExtractedList[];
  metadata: {
    totalLines: number;
    totalChars: number;
    hasNumericClaims: boolean;
    hasLists: boolean;
  };
}

/**
 * Tool result from MCP execution
 */
export interface ToolResult {
  tool_use_id: string;
  toolName: string;
  type: 'tool_result';
  content: string; // JSON stringified data
  is_error?: boolean;
  parsedContent?: any; // Parsed JSON
  timestamp?: Date;
}

/**
 * Severity levels for validation errors
 */
export type ValidationSeverity = 'critical' | 'major' | 'minor' | 'none';

/**
 * Result of validating a single claim
 */
export interface ValidationResult {
  claim: NumericClaim;
  isValid: boolean;
  actualValue: number | null;
  claimedValue: number;
  error: number | null; // Absolute difference
  errorPercent: number | null; // Percentage difference
  severity: ValidationSeverity;
  groundTruth: GroundTruth | null;
  validationMethod: string; // Description of how validation was performed
}

/**
 * Ground truth data used for validation
 */
export interface GroundTruth {
  source: string; // Tool name that provided the data
  toolUseId?: string;
  path: string; // JSON path to the value (e.g., "data.items.length")
  rawData: any; // The actual data from the tool
  extractionMethod: string; // How the value was extracted
}

/**
 * Types of corrections that can be applied
 */
export type CorrectionType = 'replace' | 'remove' | 'add' | 'truncate' | 'regenerate';

/**
 * A correction action to be applied to the response
 */
export interface CorrectionAction {
  type: CorrectionType;
  location: {
    start: number;
    end: number;
  };
  original: string;
  corrected: string;
  reason: string;
  severity: ValidationSeverity;
  relatedClaim?: NumericClaim;
  relatedList?: ExtractedList;
}

/**
 * Result of correcting a response
 */
export interface CorrectedResponse {
  text: string; // Corrected response text
  correctionsMade: boolean;
  corrections: CorrectionAction[];
  severity: ValidationSeverity; // Highest severity of all corrections
  validationResults: ValidationResult[];
  metadata: {
    originalLength: number;
    correctedLength: number;
    claimsValidated: number;
    claimsCorrected: number;
    listsValidated: number;
    listsCorrected: number;
  };
}

/**
 * Configuration for validation behavior
 */
export interface ValidationConfig {
  // Tolerance for numeric comparisons
  countTolerance: number; // Absolute difference allowed (default: 0)
  percentageTolerance: number; // Percentage points allowed (default: 0.1)

  // Validation strictness
  strictMode: boolean; // If true, fail on any discrepancy (default: true)

  // Correction behavior
  autoCorrect: boolean; // If true, automatically fix errors (default: true)
  blockOnCritical: boolean; // If true, block response with critical errors (default: true)

  // Priority weights for different claim types
  priorityWeights: {
    deviceCount: number; // default: 10 (highest)
    uptime: number; // default: 8
    percentage: number; // default: 7
    streamAggregation: number; // default: 5
    other: number; // default: 3
  };
}

/**
 * Context for validation (conversation state)
 */
export interface ValidationContext {
  conversationId: string;
  messageCount: number;
  toolResults: ToolResult[];
  responseText: string;
  complexity?: 'SIMPLE' | 'PROCEDURAL' | 'ANALYTICAL';
}

/**
 * Statistics for monitoring validation performance
 */
export interface ValidationStats {
  timestamp: Date;
  conversationId: string;
  claimsValidated: number;
  errorsDetected: number;
  errorsByType: Record<ClaimType, number>;
  errorsBySeverity: Record<ValidationSeverity, number>;
  correctionsMade: number;
  avgErrorPercent: number;
  validationDurationMs: number;
}

/**
 * Pattern for matching numeric claims in text
 */
export interface ClaimPattern {
  regex: RegExp;
  claimType: ClaimType;
  entityType: EntityType;
  extractValue: (match: RegExpMatchArray) => number;
  extractFilter?: (match: RegExpMatchArray) => string | undefined;
}

/**
 * Strategy for extracting ground truth from tool results
 */
export interface GroundTruthStrategy {
  name: string;
  applicableTools: string[]; // Tool names this strategy can use
  applicableClaimTypes: ClaimType[];
  extract: (claim: NumericClaim, toolResults: ToolResult[]) => GroundTruth | null;
  priority: number; // Higher = preferred when multiple strategies applicable
}
