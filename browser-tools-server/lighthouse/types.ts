/**
 * Audit categories available in Lighthouse
 */
export enum AuditCategory {
  ACCESSIBILITY = "accessibility",
  PERFORMANCE = "performance",
  SEO = "seo",
  BEST_PRACTICES = "best-practices", // Not yet implemented
  PWA = "pwa", // Not yet implemented
}

/**
 * Base interface for Lighthouse report metadata
 */
export interface LighthouseReport<T = any> {
  metadata: {
    url: string;
    timestamp: string; // ISO 8601, e.g., "2025-02-27T14:30:00Z"
    device: string; // e.g., "mobile", "desktop"
    lighthouseVersion: string; // e.g., "10.4.0"
  };

  // For backward compatibility with existing report formats
  overallScore?: number;
  failedAuditsCount?: number;
  passedAuditsCount?: number;
  manualAuditsCount?: number;
  informativeAuditsCount?: number;
  notApplicableAuditsCount?: number;
  failedAudits?: any[];

  // New format for specialized reports
  report?: T; // Generic report data that will be specialized by each audit type
}

/**
 * Configuration options for Lighthouse audits
 */
export interface LighthouseConfig {
  flags: {
    output: string[];
    onlyCategories: string[];
    formFactor: string;
    port: number | undefined;
    screenEmulation: {
      mobile: boolean;
      width: number;
      height: number;
      deviceScaleFactor: number;
      disabled: boolean;
    };
  };
  config: {
    extends: string;
    settings: {
      onlyCategories: string[];
      emulatedFormFactor: string;
      throttling: {
        cpuSlowdownMultiplier: number;
      };
    };
  };
}
