import { Result as LighthouseResult } from "lighthouse";
import { AuditCategory, LighthouseReport } from "./types.js";
import { runLighthouseAudit } from "./index.js";

// === Accessibility Report Types ===

/**
 * Accessibility-specific report content structure
 */
export interface AccessibilityReportContent {
  score: number; // Overall score (0-100)
  audit_counts: {
    // Counts of different audit types
    failed: number;
    passed: number;
    manual: number;
    informative: number;
    not_applicable: number;
  };
  issues: AIAccessibilityIssue[];
  categories: {
    [category: string]: {
      score: number;
      issues_count: number;
    };
  };
  critical_elements: AIAccessibilityElement[];
  prioritized_recommendations?: string[]; // Ordered list of recommendations
}

/**
 * Full accessibility report implementing the base LighthouseReport interface
 */
export type AIOptimizedAccessibilityReport =
  LighthouseReport<AccessibilityReportContent>;

/**
 * AI-optimized accessibility issue
 */
interface AIAccessibilityIssue {
  id: string; // e.g., "color-contrast"
  title: string; // e.g., "Color contrast is sufficient"
  impact: "critical" | "serious" | "moderate" | "minor";
  category: string; // e.g., "contrast", "aria", "forms", "keyboard"
  elements?: AIAccessibilityElement[]; // Elements with issues
  score: number | null; // 0-1 or null
}

/**
 * Accessibility element with issues
 */
interface AIAccessibilityElement {
  selector: string; // CSS selector
  snippet?: string; // HTML snippet
  label?: string; // Element label
  issue_description?: string; // Description of the issue
  value?: string | number; // Current value (e.g., contrast ratio)
}

// Original interfaces for backward compatibility
interface AccessibilityAudit {
  id: string; // e.g., "color-contrast"
  title: string; // e.g., "Color contrast is sufficient"
  description: string; // e.g., "Ensures text is readable..."
  score: number | null; // 0-1 (normalized), null for manual/informative
  scoreDisplayMode: string; // e.g., "binary", "numeric", "manual"
  details?: AuditDetails; // Optional, structured details
  weight?: number; // Optional, audit weight for impact calculation
}

type AuditDetails = {
  items?: Array<{
    node?: {
      selector: string; // e.g., ".my-class"
      snippet?: string; // HTML snippet
      nodeLabel?: string; // e.g., "Modify logging size limits / truncation"
      explanation?: string; // Explanation of why the node fails the audit
    };
    value?: string | number; // Specific value (e.g., contrast ratio)
    explanation?: string; // Explanation at the item level
  }>;
  debugData?: string; // Optional, debug information
  [key: string]: any; // Flexible for other detail types (tables, etc.)
};

// Original limits were optimized for human consumption
// This ensures we always include critical issues while limiting less important ones
const DETAIL_LIMITS = {
  critical: Number.MAX_SAFE_INTEGER, // No limit for critical issues
  serious: 15, // Up to 15 items for serious issues
  moderate: 10, // Up to 10 items for moderate issues
  minor: 3, // Up to 3 items for minor issues
};

/**
 * Runs an accessibility audit on the specified URL
 * @param url The URL to audit
 * @returns Promise resolving to AI-optimized accessibility audit results
 */
export async function runAccessibilityAudit(
  url: string
): Promise<AIOptimizedAccessibilityReport> {
  try {
    const lhr = await runLighthouseAudit(url, [AuditCategory.ACCESSIBILITY]);
    return extractAIOptimizedData(lhr, url);
  } catch (error) {
    throw new Error(
      `Accessibility audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Extract AI-optimized accessibility data from Lighthouse results
 */
const extractAIOptimizedData = (
  lhr: LighthouseResult,
  url: string
): AIOptimizedAccessibilityReport => {
  const categoryData = lhr.categories[AuditCategory.ACCESSIBILITY];
  const audits = lhr.audits || {};

  // Add metadata
  const metadata = {
    url,
    timestamp: lhr.fetchTime || new Date().toISOString(),
    device: "desktop", // This could be made configurable
    lighthouseVersion: lhr.lighthouseVersion,
  };

  // Initialize variables
  const issues: AIAccessibilityIssue[] = [];
  const criticalElements: AIAccessibilityElement[] = [];
  const categories: {
    [category: string]: { score: number; issues_count: number };
  } = {};

  // Count audits by type
  let failedCount = 0;
  let passedCount = 0;
  let manualCount = 0;
  let informativeCount = 0;
  let notApplicableCount = 0;

  // Process audit refs
  const auditRefs = categoryData?.auditRefs || [];

  // First pass: count audits by type and initialize categories
  auditRefs.forEach((ref) => {
    const audit = audits[ref.id];
    if (!audit) return;

    // Count by scoreDisplayMode
    if (audit.scoreDisplayMode === "manual") {
      manualCount++;
    } else if (audit.scoreDisplayMode === "informative") {
      informativeCount++;
    } else if (audit.scoreDisplayMode === "notApplicable") {
      notApplicableCount++;
    } else if (audit.score !== null) {
      // Binary pass/fail
      if (audit.score >= 0.9) {
        passedCount++;
      } else {
        failedCount++;
      }
    }

    // Process categories
    if (ref.group) {
      // Initialize category if not exists
      if (!categories[ref.group]) {
        categories[ref.group] = { score: 0, issues_count: 0 };
      }

      // Update category score and issues count
      if (audit.score !== null && audit.score < 0.9) {
        categories[ref.group].issues_count++;
      }
    }
  });

  // Second pass: process failed audits into AI-friendly format
  auditRefs
    .filter((ref) => {
      const audit = audits[ref.id];
      return audit && audit.score !== null && audit.score < 0.9;
    })
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    // No limit on number of failed audits - we'll show them all
    .forEach((ref) => {
      const audit = audits[ref.id];

      // Determine impact level based on score and weight
      let impact: "critical" | "serious" | "moderate" | "minor" = "moderate";
      if (audit.score === 0) {
        impact = "critical";
      } else if (audit.score !== null && audit.score <= 0.5) {
        impact = "serious";
      } else if (audit.score !== null && audit.score > 0.7) {
        impact = "minor";
      }

      // Create elements array
      const elements: AIAccessibilityElement[] = [];

      if (audit.details) {
        const details = audit.details as any;
        if (details.items && Array.isArray(details.items)) {
          const items = details.items;
          // Apply limits based on impact level
          const itemLimit = DETAIL_LIMITS[impact];
          items.slice(0, itemLimit).forEach((item: any) => {
            if (item.node) {
              const element: AIAccessibilityElement = {
                selector: item.node.selector,
                snippet: item.node.snippet,
                label: item.node.nodeLabel,
                issue_description: item.node.explanation || item.explanation,
              };

              if (item.value !== undefined) {
                element.value = item.value;
              }

              elements.push(element);

              // Add to critical elements if impact is critical or serious
              if (impact === "critical" || impact === "serious") {
                criticalElements.push(element);
              }
            }
          });
        }
      }

      // Create the issue
      const issue: AIAccessibilityIssue = {
        id: ref.id,
        title: audit.title,
        impact,
        category: ref.group || "other",
        elements: elements.length > 0 ? elements : undefined,
        score: audit.score,
      };

      issues.push(issue);
    });

  // Calculate overall score
  const score = Math.round((categoryData?.score || 0) * 100);

  // Generate prioritized recommendations
  const prioritized_recommendations: string[] = [];

  // Add category-specific recommendations
  Object.entries(categories)
    .filter(([_, data]) => data.issues_count > 0)
    .sort(([_, a], [__, b]) => b.issues_count - a.issues_count)
    .forEach(([category, data]) => {
      let recommendation = "";

      switch (category) {
        case "a11y-color-contrast":
          recommendation = "Improve color contrast for better readability";
          break;
        case "a11y-names-labels":
          recommendation = "Add proper labels to all interactive elements";
          break;
        case "a11y-aria":
          recommendation = "Fix ARIA attributes and roles";
          break;
        case "a11y-navigation":
          recommendation = "Improve keyboard navigation and focus management";
          break;
        case "a11y-language":
          recommendation = "Add proper language attributes to HTML";
          break;
        case "a11y-tables-lists":
          recommendation = "Fix table and list structures for screen readers";
          break;
        default:
          recommendation = `Fix ${data.issues_count} issues in ${category}`;
      }

      prioritized_recommendations.push(recommendation);
    });

  // Add specific high-impact recommendations
  if (issues.some((issue) => issue.id === "color-contrast")) {
    prioritized_recommendations.push(
      "Fix low contrast text for better readability"
    );
  }

  if (issues.some((issue) => issue.id === "document-title")) {
    prioritized_recommendations.push("Add a descriptive page title");
  }

  if (issues.some((issue) => issue.id === "image-alt")) {
    prioritized_recommendations.push("Add alt text to all images");
  }

  // Create the report content
  const reportContent: AccessibilityReportContent = {
    score,
    audit_counts: {
      failed: failedCount,
      passed: passedCount,
      manual: manualCount,
      informative: informativeCount,
      not_applicable: notApplicableCount,
    },
    issues,
    categories,
    critical_elements: criticalElements,
    prioritized_recommendations:
      prioritized_recommendations.length > 0
        ? prioritized_recommendations
        : undefined,
  };

  // Return the full report following the LighthouseReport interface
  return {
    metadata,
    report: reportContent,
  };
};
