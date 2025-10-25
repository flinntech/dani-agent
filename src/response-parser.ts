/**
 * Response Parser - Extracts numeric claims and lists from Claude's natural language responses
 */

import {
  NumericClaim,
  ExtractedList,
  ParsedResponse,
  EntityType,
  ClaimPattern,
} from './types/validation.types';
import { Logger } from './types';

/**
 * Patterns for extracting numeric claims from text
 */
const CLAIM_PATTERNS: ClaimPattern[] = [
  // Device counts - format: "**Online (Connected):** 9 devices"
  {
    regex: /\*?\*?(?:online|connected|active)\s*\([^)]*\)\s*:\*?\*?\s*(\d+)\s+devices?/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'connected',
  },
  {
    regex: /\*?\*?(?:offline|disconnected|inactive)\s*\([^)]*\)\s*:\*?\*?\s*(\d+)\s+devices?/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'disconnected',
  },
  // Device counts - format: "Connected devices: 8"
  {
    regex: /(?:connected|online|active)\s+devices?:\s*(\d+)/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'connected',
  },
  {
    regex: /(?:disconnected|offline|inactive)\s+devices?:\s*(\d+)/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'disconnected',
  },
  // Device counts - format: "8 connected devices"
  {
    regex: /(\d+)\s+(?:connected|online|active)\s+devices?/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'connected',
  },
  {
    regex: /(\d+)\s+(?:disconnected|offline|inactive)\s+devices?/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'disconnected',
  },
  // Device counts - format: "Never Connected: 3 devices"
  {
    regex: /never\s+connected\s*:\s*(\d+)\s+devices?/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'never_connected',
  },
  // Total device count - format: "Total devices: 72"
  {
    regex: /\*?\*?total\s+devices?\s*:\*?\*?\s*(\d+)/gi,
    claimType: 'count',
    entityType: 'device',
    extractValue: (match) => parseInt(match[1], 10),
    extractFilter: () => 'total',
  },

  // Percentages (generic)
  {
    regex: /(\d+(?:\.\d+)?)\s*%/g,
    claimType: 'percentage',
    entityType: 'other',
    extractValue: (match) => parseFloat(match[1]),
  },

  // Uptime percentages
  {
    regex: /uptime:\s*(\d+(?:\.\d+)?)\s*%/gi,
    claimType: 'percentage',
    entityType: 'device',
    extractValue: (match) => parseFloat(match[1]),
    extractFilter: () => 'uptime',
  },
  {
    regex: /(\d+(?:\.\d+)?)\s*%\s+uptime/gi,
    claimType: 'percentage',
    entityType: 'device',
    extractValue: (match) => parseFloat(match[1]),
    extractFilter: () => 'uptime',
  },

  // Stream counts
  {
    regex: /(\d+)\s+streams?/gi,
    claimType: 'count',
    entityType: 'stream',
    extractValue: (match) => parseInt(match[1], 10),
  },

  // Alert counts
  {
    regex: /(\d+)\s+alerts?/gi,
    claimType: 'count',
    entityType: 'alert',
    extractValue: (match) => parseInt(match[1], 10),
  },

  // Averages
  {
    regex: /average:\s*(\d+(?:\.\d+)?)/gi,
    claimType: 'average',
    entityType: 'other',
    extractValue: (match) => parseFloat(match[1]),
  },

  // Totals/Sums
  {
    regex: /total:\s*(\d+(?:,\d{3})*(?:\.\d+)?)/gi,
    claimType: 'sum',
    entityType: 'other',
    extractValue: (match) => parseFloat(match[1].replace(/,/g, '')),
  },
];

/**
 * Patterns for detecting lists in markdown/text format
 */
const LIST_PATTERNS = {
  // Numbered lists: "1. Device Name"
  numbered: /^\s*\d+\.\s+(.+?)(?:\s*\(.*?\))?$/gm,

  // Bullet lists: "- Device Name" or "* Device Name"
  bullet: /^\s*[-*]\s+(.+?)(?:\s*\(.*?\))?$/gm,

  // Headers that introduce lists
  listHeader: /^(?:currently\s+)?(?:online|connected|disconnected|offline|active)\s+devices?:?\s*$/gim,
};

export class ResponseParser {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Parse a response and extract numeric claims and lists
   */
  parse(responseText: string): ParsedResponse {
    const lines = responseText.split('\n');

    const claims = this.extractClaims(responseText);
    const lists = this.extractLists(responseText, lines);

    const parsed: ParsedResponse = {
      originalText: responseText,
      claims,
      lists,
      metadata: {
        totalLines: lines.length,
        totalChars: responseText.length,
        hasNumericClaims: claims.length > 0,
        hasLists: lists.length > 0,
      },
    };

    this.logger.debug('Parsed response', {
      claimsFound: claims.length,
      listsFound: lists.length,
      claimTypes: claims.map(c => c.type),
      listTypes: lists.map(l => l.type),
    });

    return parsed;
  }

  /**
   * Extract numeric claims from text using patterns
   */
  private extractClaims(text: string): NumericClaim[] {
    const claims: NumericClaim[] = [];
    const lines = text.split('\n');

    for (const pattern of CLAIM_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const value = pattern.extractValue(match);
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;

        // Find line number
        let charCount = 0;
        let lineNumber = 0;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1; // +1 for newline
          if (charCount > startIndex) {
            lineNumber = i;
            break;
          }
        }

        // Extract context (the line containing the claim)
        const context = lines[lineNumber] || '';

        const claim: NumericClaim = {
          type: pattern.claimType,
          entity: pattern.entityType,
          value,
          context,
          lineNumber,
          startIndex,
          endIndex,
          rawText: match[0],
          filter: pattern.extractFilter ? pattern.extractFilter(match) : undefined,
        };

        claims.push(claim);
      }
    }

    // Sort by position in text
    claims.sort((a, b) => a.startIndex - b.startIndex);

    return claims;
  }

  /**
   * Extract lists from text
   */
  private extractLists(text: string, lines: string[]): ExtractedList[] {
    const lists: ExtractedList[] = [];

    // Find list headers
    const headerRegex = new RegExp(LIST_PATTERNS.listHeader.source, LIST_PATTERNS.listHeader.flags);
    let headerMatch: RegExpExecArray | null;

    while ((headerMatch = headerRegex.exec(text)) !== null) {
      const headerText = headerMatch[0];
      const headerIndex = headerMatch.index;

      // Determine entity type from header
      const entityType = this.detectEntityTypeFromHeader(headerText);

      // Find list items following the header
      const items = this.extractListItemsAfterHeader(text, headerIndex + headerText.length, lines);

      if (items.length > 0) {
        lists.push({
          type: entityType,
          items,
          itemCount: items.length,
          startIndex: headerIndex,
          endIndex: headerIndex + headerText.length + this.calculateListLength(items, text, headerIndex),
          headerText,
        });
      }
    }

    return lists;
  }

  /**
   * Detect entity type from list header text
   */
  private detectEntityTypeFromHeader(headerText: string): EntityType {
    const lower = headerText.toLowerCase();
    if (lower.includes('device')) return 'device';
    if (lower.includes('stream')) return 'stream';
    if (lower.includes('alert')) return 'alert';
    if (lower.includes('group')) return 'group';
    if (lower.includes('job')) return 'job';
    return 'other';
  }

  /**
   * Extract list items after a header
   */
  private extractListItemsAfterHeader(text: string, startIndex: number, _lines: string[]): string[] {
    const items: string[] = [];
    const textAfterHeader = text.substring(startIndex);

    // Try numbered list pattern
    const numberedRegex = new RegExp(LIST_PATTERNS.numbered.source, LIST_PATTERNS.numbered.flags);
    let numberedMatch: RegExpExecArray | null;
    const numberedItems: Array<{ index: number; text: string }> = [];

    while ((numberedMatch = numberedRegex.exec(textAfterHeader)) !== null) {
      numberedItems.push({
        index: numberedMatch.index,
        text: numberedMatch[1].trim(),
      });
    }

    // Try bullet list pattern
    const bulletRegex = new RegExp(LIST_PATTERNS.bullet.source, LIST_PATTERNS.bullet.flags);
    let bulletMatch: RegExpExecArray | null;
    const bulletItems: Array<{ index: number; text: string }> = [];

    while ((bulletMatch = bulletRegex.exec(textAfterHeader)) !== null) {
      bulletItems.push({
        index: bulletMatch.index,
        text: bulletMatch[1].trim(),
      });
    }

    // Use whichever pattern found more items (or numbered if tie)
    const selectedItems = numberedItems.length >= bulletItems.length ? numberedItems : bulletItems;

    // Stop at first non-list line or empty line after consecutive list items
    if (selectedItems.length > 0) {
      selectedItems.sort((a, b) => a.index - b.index);

      let lastIndex = -1;
      for (const item of selectedItems) {
        // Check if this item is consecutive (within reasonable distance of last)
        if (lastIndex === -1 || (item.index - lastIndex) < 200) {
          items.push(item.text);
          lastIndex = item.index;
        } else {
          // Gap too large, stop here
          break;
        }
      }
    }

    return items;
  }

  /**
   * Calculate the length of a list in the text
   */
  private calculateListLength(items: string[], text: string, startIndex: number): number {
    if (items.length === 0) return 0;

    // Find the last item in the text
    const lastItem = items[items.length - 1];
    const lastItemIndex = text.indexOf(lastItem, startIndex);

    if (lastItemIndex !== -1) {
      return (lastItemIndex - startIndex) + lastItem.length;
    }

    return 0;
  }


  /**
   * Find claims related to a specific list
   */
  findRelatedClaim(list: ExtractedList, claims: NumericClaim[]): NumericClaim | undefined {
    // Look for a count claim of the same entity type near the list
    return claims.find(claim =>
      claim.entity === list.type &&
      claim.type === 'count' &&
      Math.abs(claim.startIndex - list.startIndex) < 500 // Within 500 chars
    );
  }

  /**
   * Detect count/list mismatches
   */
  detectCountListMismatches(parsed: ParsedResponse): Array<{
    claim: NumericClaim;
    list: ExtractedList;
    claimedCount: number;
    actualCount: number;
  }> {
    const mismatches: Array<{
      claim: NumericClaim;
      list: ExtractedList;
      claimedCount: number;
      actualCount: number;
    }> = [];

    for (const list of parsed.lists) {
      const relatedClaim = this.findRelatedClaim(list, parsed.claims);

      if (relatedClaim && relatedClaim.value !== list.itemCount) {
        mismatches.push({
          claim: relatedClaim,
          list,
          claimedCount: relatedClaim.value,
          actualCount: list.itemCount,
        });
      }
    }

    return mismatches;
  }

}
