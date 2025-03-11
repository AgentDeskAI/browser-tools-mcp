import { Result as LighthouseResult } from "lighthouse";
import { AuditCategory, LighthouseReport } from "./types.js";
import { runLighthouseAudit } from "./index.js";

// === SEO Report Types ===

/**
 * SEO-specific report content structure
 */
export interface SEOReportContent {
  score: number; // Overall score (0-100)
  audit_counts: {
    // Counts of different audit types
    failed: number;
    passed: number;
    manual: number;
    informative: number;
    not_applicable: number;
  };
  issues: AISEOIssue[];
  categories: {
    [category: string]: {
      score: number;
      issues_count: number;
    };
  };
  prioritized_recommendations?: string[]; // Ordered list of recommendations
}

/**
 * Full SEO report implementing the base LighthouseReport interface
 */
export type AIOptimizedSEOReport = LighthouseReport<SEOReportContent>;

/**
 * AI-optimized SEO issue
 */
interface AISEOIssue {
  id: string; // e.g., "meta-description"
  title: string; // e.g., "Document has a meta description"
  impact: "critical" | "serious" | "moderate" | "minor";
  category: string; // e.g., "content", "mobile", "crawlability"
  details?: {
    selector?: string; // CSS selector if applicable
    value?: string; // Current value
    issue?: string; // Description of the issue
  }[];
  score: number | null; // 0-1 or null
}

// Original interfaces for backward compatibility
interface SEOAudit {
  id: string; // e.g., "meta-description"
  title: string; // e.g., "Document has a meta description"
  description: string; // e.g., "Meta descriptions improve SEO..."
  score: number | null; // 0-1 or null
  scoreDisplayMode: string; // e.g., "binary"
  details?: SEOAuditDetails; // Optional, structured details
  weight?: number; // For prioritization
}

interface SEOAuditDetails {
  items?: Array<{
    selector?: string; // e.g., "meta[name='description']"
    issue?: string; // e.g., "Meta description is missing"
    value?: string; // e.g., Current meta description text
  }>;
  type?: string; // e.g., "table"
}

// This ensures we always include critical issues while limiting less important ones
const DETAIL_LIMITS = {
  critical: Number.MAX_SAFE_INTEGER, // No limit for critical issues
  serious: 15, // Up to 15 items for serious issues
  moderate: 10, // Up to 10 items for moderate issues
  minor: 3, // Up to 3 items for minor issues
};

/**
 * Runs an SEO audit on the specified URL
 * @param url The URL to audit
 * @returns Promise resolving to AI-optimized SEO audit results
 */
export async function runSEOAudit(url: string): Promise<AIOptimizedSEOReport> {
  try {
    const lhr = await runLighthouseAudit(url, [AuditCategory.SEO]);
    return extractAIOptimizedData(lhr, url);
  } catch (error) {
    throw new Error(
      `SEO audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Extract AI-optimized SEO data from Lighthouse results
 */
const extractAIOptimizedData = (
  lhr: LighthouseResult,
  url: string
): AIOptimizedSEOReport => {
  const categoryData = lhr.categories[AuditCategory.SEO];
  const audits = lhr.audits || {};

  // Add metadata
  const metadata = {
    url,
    timestamp: lhr.fetchTime || new Date().toISOString(),
    device: "desktop", // This could be made configurable
    lighthouseVersion: lhr.lighthouseVersion,
  };

  // Initialize variables
  const issues: AISEOIssue[] = [];
  const categories: {
    [category: string]: { score: number; issues_count: number };
  } = {
    content: { score: 0, issues_count: 0 },
    mobile: { score: 0, issues_count: 0 },
    crawlability: { score: 0, issues_count: 0 },
    other: { score: 0, issues_count: 0 },
  };

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

    // Categorize the issue
    let category = "other";
    if (
      ref.id.includes("crawl") ||
      ref.id.includes("http") ||
      ref.id.includes("redirect") ||
      ref.id.includes("robots")
    ) {
      category = "crawlability";
    } else if (
      ref.id.includes("viewport") ||
      ref.id.includes("font-size") ||
      ref.id.includes("tap-targets")
    ) {
      category = "mobile";
    } else if (
      ref.id.includes("document") ||
      ref.id.includes("meta") ||
      ref.id.includes("description") ||
      ref.id.includes("canonical") ||
      ref.id.includes("title") ||
      ref.id.includes("link")
    ) {
      category = "content";
    }

    // Update category score and issues count
    if (audit.score !== null && audit.score < 0.9) {
      categories[category].issues_count++;
    }
  });

  // Second pass: process failed audits into AI-friendly format
  auditRefs
    .filter((ref) => {
      const audit = audits[ref.id];
      return audit && audit.score !== null && audit.score < 0.9;
    })
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    // No limit on failed audits - we'll filter dynamically based on impact
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

      // Categorize the issue
      let category = "other";
      if (
        ref.id.includes("crawl") ||
        ref.id.includes("http") ||
        ref.id.includes("redirect") ||
        ref.id.includes("robots")
      ) {
        category = "crawlability";
      } else if (
        ref.id.includes("viewport") ||
        ref.id.includes("font-size") ||
        ref.id.includes("tap-targets")
      ) {
        category = "mobile";
      } else if (
        ref.id.includes("document") ||
        ref.id.includes("meta") ||
        ref.id.includes("description") ||
        ref.id.includes("canonical") ||
        ref.id.includes("title") ||
        ref.id.includes("link")
      ) {
        category = "content";
      }

      // Extract details
      const details: { selector?: string; value?: string; issue?: string }[] =
        [];

      if (audit.details) {
        const auditDetails = audit.details as any;
        if (auditDetails.items && Array.isArray(auditDetails.items)) {
          // Determine item limit based on impact
          const itemLimit = DETAIL_LIMITS[impact];

          auditDetails.items.slice(0, itemLimit).forEach((item: any) => {
            const detail: {
              selector?: string;
              value?: string;
              issue?: string;
            } = {};

            if (item.selector) {
              detail.selector = item.selector;
            }

            if (item.value !== undefined) {
              detail.value = item.value;
            }

            if (item.issue) {
              detail.issue = item.issue;
            }

            if (Object.keys(detail).length > 0) {
              details.push(detail);
            }
          });
        }
      }

      // Create the issue
      const issue: AISEOIssue = {
        id: ref.id,
        title: audit.title,
        impact,
        category,
        details: details.length > 0 ? details : undefined,
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
      if (data.issues_count === 0) return;

      let recommendation = "";

      switch (category) {
        case "content":
          recommendation = `Improve SEO content (${data.issues_count} issues): titles, descriptions, and headers`;
          break;
        case "mobile":
          recommendation = `Optimize for mobile devices (${data.issues_count} issues)`;
          break;
        case "crawlability":
          recommendation = `Fix crawlability issues (${data.issues_count} issues): robots.txt, sitemaps, and redirects`;
          break;
        default:
          recommendation = `Fix ${data.issues_count} SEO issues in category: ${category}`;
      }

      prioritized_recommendations.push(recommendation);
    });

  // Add specific high-impact recommendations
  if (issues.some((issue) => issue.id === "meta-description")) {
    prioritized_recommendations.push(
      "Add a meta description to improve click-through rate"
    );
  }

  if (issues.some((issue) => issue.id === "document-title")) {
    prioritized_recommendations.push(
      "Add a descriptive page title with keywords"
    );
  }

  if (issues.some((issue) => issue.id === "hreflang")) {
    prioritized_recommendations.push(
      "Fix hreflang implementation for international SEO"
    );
  }

  if (issues.some((issue) => issue.id === "canonical")) {
    prioritized_recommendations.push("Implement proper canonical tags");
  }

  // Create the report content
  const reportContent: SEOReportContent = {
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
