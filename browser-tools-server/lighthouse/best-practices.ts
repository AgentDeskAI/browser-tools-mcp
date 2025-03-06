import { Result as LighthouseResult } from "lighthouse";
import { AuditCategory, LighthouseReport } from "./types.js";
import { runLighthouseAudit } from "./index.js";

// === Best Practices Report Types ===

/**
 * Best Practices-specific report content structure
 */
export interface BestPracticesReportContent {
  score: number; // Overall score (0-100)
  audit_counts: {
    // Counts of different audit types
    failed: number;
    passed: number;
    manual: number;
    informative: number;
    not_applicable: number;
  };
  issues: AIBestPracticesIssue[];
  categories: {
    [category: string]: {
      score: number;
      issues_count: number;
    };
  };
  prioritized_recommendations?: string[]; // Ordered list of recommendations
}

/**
 * Full Best Practices report implementing the base LighthouseReport interface
 */
export type AIOptimizedBestPracticesReport =
  LighthouseReport<BestPracticesReportContent>;

/**
 * AI-optimized Best Practices issue
 */
interface AIBestPracticesIssue {
  id: string; // e.g., "js-libraries"
  title: string; // e.g., "Detected JavaScript libraries"
  impact: "critical" | "serious" | "moderate" | "minor";
  category: string; // e.g., "security", "trust", "user-experience", "browser-compat"
  details?: {
    name?: string; // Name of the item (e.g., library name, vulnerability)
    version?: string; // Version information if applicable
    value?: string; // Current value or status
    issue?: string; // Description of the issue
  }[];
  score: number | null; // 0-1 or null
}

// Original interfaces for backward compatibility
interface BestPracticesAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  details?: BestPracticesAuditDetails;
}

interface BestPracticesAuditDetails {
  items?: Array<Record<string, unknown>>;
  type?: string; // e.g., "table"
}

// This ensures we always include critical issues while limiting less important ones
const DETAIL_LIMITS: Record<string, number> = {
  critical: Number.MAX_SAFE_INTEGER, // No limit for critical issues
  serious: 15, // Up to 15 items for serious issues
  moderate: 10, // Up to 10 items for moderate issues
  minor: 3, // Up to 3 items for minor issues
};

/**
 * Runs a Best Practices audit on the specified URL
 * @param url The URL to audit
 * @returns Promise resolving to AI-optimized Best Practices audit results
 */
export async function runBestPracticesAudit(
  url: string
): Promise<AIOptimizedBestPracticesReport> {
  try {
    const lhr = await runLighthouseAudit(url, [AuditCategory.BEST_PRACTICES]);
    return extractAIOptimizedData(lhr, url);
  } catch (error) {
    throw new Error(
      `Best Practices audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Extract AI-optimized Best Practices data from Lighthouse results
 */
const extractAIOptimizedData = (
  lhr: LighthouseResult,
  url: string
): AIOptimizedBestPracticesReport => {
  const categoryData = lhr.categories[AuditCategory.BEST_PRACTICES];
  const audits = lhr.audits || {};

  // Add metadata
  const metadata = {
    url,
    timestamp: lhr.fetchTime || new Date().toISOString(),
    device: lhr.configSettings?.formFactor || "desktop",
    lighthouseVersion: lhr.lighthouseVersion || "unknown",
  };

  // Process audit results
  const issues: AIBestPracticesIssue[] = [];
  const categories: { [key: string]: { score: number; issues_count: number } } =
    {
      security: { score: 0, issues_count: 0 },
      trust: { score: 0, issues_count: 0 },
      "user-experience": { score: 0, issues_count: 0 },
      "browser-compat": { score: 0, issues_count: 0 },
      other: { score: 0, issues_count: 0 },
    };

  // Counters for audit types
  let failedCount = 0;
  let passedCount = 0;
  let manualCount = 0;
  let informativeCount = 0;
  let notApplicableCount = 0;

  // Process failed audits (score < 1)
  const failedAudits = Object.entries(audits)
    .filter(([, audit]) => {
      const score = audit.score;
      return (
        score !== null &&
        score < 1 &&
        audit.scoreDisplayMode !== "manual" &&
        audit.scoreDisplayMode !== "notApplicable"
      );
    })
    .map(([auditId, audit]) => ({ auditId, ...audit }));

  // Update counters
  Object.values(audits).forEach((audit) => {
    const { score, scoreDisplayMode } = audit;

    if (scoreDisplayMode === "manual") {
      manualCount++;
    } else if (scoreDisplayMode === "informative") {
      informativeCount++;
    } else if (scoreDisplayMode === "notApplicable") {
      notApplicableCount++;
    } else if (score === 1) {
      passedCount++;
    } else if (score !== null && score < 1) {
      failedCount++;
    }
  });

  // Process failed audits into AI-friendly format
  failedAudits.forEach((ref: any) => {
    // Determine impact level based on audit score and weight
    let impact: "critical" | "serious" | "moderate" | "minor" = "moderate";
    const score = ref.score || 0;

    // Use a more reliable approach to determine impact
    if (score === 0) {
      impact = "critical";
    } else if (score < 0.5) {
      impact = "serious";
    } else if (score < 0.9) {
      impact = "moderate";
    } else {
      impact = "minor";
    }

    // Categorize the issue
    let category = "other";

    // Security-related issues
    if (
      ref.auditId.includes("csp") ||
      ref.auditId.includes("security") ||
      ref.auditId.includes("vulnerab") ||
      ref.auditId.includes("password") ||
      ref.auditId.includes("cert") ||
      ref.auditId.includes("deprecat")
    ) {
      category = "security";
    }
    // Trust and legitimacy issues
    else if (
      ref.auditId.includes("doctype") ||
      ref.auditId.includes("charset") ||
      ref.auditId.includes("legit") ||
      ref.auditId.includes("trust")
    ) {
      category = "trust";
    }
    // User experience issues
    else if (
      ref.auditId.includes("user") ||
      ref.auditId.includes("experience") ||
      ref.auditId.includes("console") ||
      ref.auditId.includes("errors") ||
      ref.auditId.includes("paste")
    ) {
      category = "user-experience";
    }
    // Browser compatibility issues
    else if (
      ref.auditId.includes("compat") ||
      ref.auditId.includes("browser") ||
      ref.auditId.includes("vendor") ||
      ref.auditId.includes("js-lib")
    ) {
      category = "browser-compat";
    }

    // Count issues by category
    categories[category].issues_count++;

    // Create issue object
    const issue: AIBestPracticesIssue = {
      id: ref.auditId,
      title: ref.title,
      impact,
      category,
      score: ref.score,
      details: [],
    };

    // Extract details if available
    const refDetails = ref.details as BestPracticesAuditDetails | undefined;
    if (refDetails?.items && Array.isArray(refDetails.items)) {
      const itemLimit = DETAIL_LIMITS[impact];
      const detailItems = refDetails.items.slice(0, itemLimit);

      detailItems.forEach((item: Record<string, unknown>) => {
        issue.details = issue.details || [];

        // Different audits have different detail structures
        const detail: Record<string, string> = {};

        if (typeof item.name === "string") detail.name = item.name;
        if (typeof item.version === "string") detail.version = item.version;
        if (typeof item.issue === "string") detail.issue = item.issue;
        if (item.value !== undefined) detail.value = String(item.value);

        // For JS libraries, extract name and version
        if (
          ref.auditId === "js-libraries" &&
          typeof item.name === "string" &&
          typeof item.version === "string"
        ) {
          detail.name = item.name;
          detail.version = item.version;
        }

        // Add other generic properties that might exist
        for (const [key, value] of Object.entries(item)) {
          if (!detail[key] && typeof value === "string") {
            detail[key] = value;
          }
        }

        issue.details.push(detail as any);
      });
    }

    issues.push(issue);
  });

  // Calculate category scores (0-100)
  Object.keys(categories).forEach((category) => {
    // Simplified scoring: if there are issues in this category, score is reduced proportionally
    const issueCount = categories[category].issues_count;
    if (issueCount > 0) {
      // More issues = lower score, max penalty of 25 points per issue
      const penalty = Math.min(100, issueCount * 25);
      categories[category].score = Math.max(0, 100 - penalty);
    } else {
      categories[category].score = 100;
    }
  });

  // Generate prioritized recommendations
  const prioritized_recommendations: string[] = [];

  // Prioritize recommendations by category with most issues
  Object.entries(categories)
    .filter(([_, data]) => data.issues_count > 0)
    .sort(([_, a], [__, b]) => b.issues_count - a.issues_count)
    .forEach(([category, data]) => {
      let recommendation = "";

      switch (category) {
        case "security":
          recommendation = `Address ${data.issues_count} security issues: vulnerabilities, CSP, deprecations`;
          break;
        case "trust":
          recommendation = `Fix ${data.issues_count} trust & legitimacy issues: doctype, charset`;
          break;
        case "user-experience":
          recommendation = `Improve ${data.issues_count} user experience issues: console errors, user interactions`;
          break;
        case "browser-compat":
          recommendation = `Resolve ${data.issues_count} browser compatibility issues: outdated libraries, vendor prefixes`;
          break;
        default:
          recommendation = `Fix ${data.issues_count} other best practice issues`;
      }

      prioritized_recommendations.push(recommendation);
    });

  // Return the optimized report
  return {
    metadata,
    report: {
      score: categoryData?.score ? Math.round(categoryData.score * 100) : 0,
      audit_counts: {
        failed: failedCount,
        passed: passedCount,
        manual: manualCount,
        informative: informativeCount,
        not_applicable: notApplicableCount,
      },
      issues,
      categories,
      prioritized_recommendations,
    },
  };
};
