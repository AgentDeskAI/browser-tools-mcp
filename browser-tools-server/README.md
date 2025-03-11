# Browser Tools Server

A powerful browser tools server for capturing and managing browser events, logs, and screenshots. This server works in conjunction with the Browser Tools Chrome Extension to provide comprehensive browser debugging capabilities.

## Features

- Console log capture
- Network request monitoring
- Screenshot capture
- Element selection tracking
- WebSocket real-time communication
- Configurable log limits and settings
- Lighthouse-powered accessibility, performance, SEO, and best practices audits

## Installation

```bash
npx @agentdeskai/browser-tools-server
```

Or install globally:

```bash
npm install -g @agentdeskai/browser-tools-server
```

## Usage

1. Start the server:

```bash
npx @agentdeskai/browser-tools-server
```

2. The server will start on port 3025 by default

3. Install and enable the Browser Tools Chrome Extension

4. The server exposes the following endpoints:

- `/console-logs` - Get console logs
- `/console-errors` - Get console errors
- `/network-errors` - Get network error logs
- `/network-success` - Get successful network requests
- `/all-xhr` - Get all network requests
- `/screenshot` - Capture screenshots
- `/selected-element` - Get currently selected DOM element
- `/accessibility-audit` - Run accessibility audit on current page
- `/performance-audit` - Run performance audit on current page
- `/seo-audit` - Run SEO audit on current page

## API Documentation

### GET Endpoints

- `GET /console-logs` - Returns recent console logs
- `GET /console-errors` - Returns recent console errors
- `GET /network-errors` - Returns recent network errors
- `GET /network-success` - Returns recent successful network requests
- `GET /all-xhr` - Returns all recent network requests
- `GET /selected-element` - Returns the currently selected DOM element

### POST Endpoints

- `POST /extension-log` - Receive logs from the extension
- `POST /screenshot` - Capture and save screenshots
- `POST /selected-element` - Update the selected element
- `POST /wipelogs` - Clear all stored logs
- `POST /accessibility-audit` - Run a WCAG-compliant accessibility audit on the current page
- `POST /performance-audit` - Run a performance audit on the current page
- `POST /seo-audit` - Run a SEO audit on the current page

# Audit Functionality

The server provides Lighthouse-powered audit capabilities through four AI-optimized endpoints. These audits have been specifically tailored for AI consumption, with structured data, clear categorization, and smart prioritization.

## Smart Limit Implementation

All audit tools implement a "smart limit" approach to provide the most relevant information based on impact severity:

- **Critical issues**: No limit (all issues are shown)
- **Serious issues**: Up to 15 items per issue
- **Moderate issues**: Up to 10 items per issue
- **Minor issues**: Up to 3 items per issue

This ensures that the most important issues are always included in the response, while less important ones are limited to maintain a manageable response size for AI processing.

## Common Audit Response Structure

All audit responses follow a similar structure:

```json
{
  "metadata": {
    "url": "https://example.com",
    "timestamp": "2025-03-06T16:28:30.930Z",
    "device": "desktop",
    "lighthouseVersion": "11.7.1"
  },
  "report": {
    "score": 88,
    "audit_counts": {
      "failed": 2,
      "passed": 17,
      "manual": 10,
      "informative": 0,
      "not_applicable": 42
    }
    // Audit-specific content
    // ...
  }
}
```

## Accessibility Audit (`/accessibility-audit`)

The accessibility audit evaluates web pages against WCAG standards, identifying issues that affect users with disabilities.

### Response Format

```json
{
  "metadata": {
    "url": "https://example.com",
    "timestamp": "2025-03-06T16:28:30.930Z",
    "device": "desktop",
    "lighthouseVersion": "11.7.1"
  },
  "report": {
    "score": 88,
    "audit_counts": {
      "failed": 2,
      "passed": 17,
      "manual": 10,
      "informative": 0,
      "not_applicable": 42
    },
    "issues": [
      {
        "id": "meta-viewport",
        "title": "`[user-scalable=\"no\"]` is used in the `<meta name=\"viewport\">` element or the `[maximum-scale]` attribute is less than 5.",
        "impact": "critical",
        "category": "a11y-best-practices",
        "elements": [
          {
            "selector": "head > meta",
            "snippet": "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0\">",
            "label": "head > meta",
            "issue_description": "Fix any of the following: user-scalable on <meta> tag disables zooming on mobile devices"
          }
        ],
        "score": 0
      }
    ],
    "categories": {
      "a11y-navigation": { "score": 0, "issues_count": 0 },
      "a11y-aria": { "score": 0, "issues_count": 1 },
      "a11y-best-practices": { "score": 0, "issues_count": 1 }
    },
    "critical_elements": [
      {
        "selector": "head > meta",
        "snippet": "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0\">",
        "label": "head > meta",
        "issue_description": "Fix any of the following: user-scalable on <meta> tag disables zooming on mobile devices"
      }
    ],
    "prioritized_recommendations": [
      "Fix ARIA attributes and roles",
      "Fix 1 issues in a11y-best-practices"
    ]
  }
}
```

### Key Features

- **Issues Categorized by Impact**: Critical, serious, moderate, and minor
- **Element-Specific Information**: Selectors, snippets, and labels for affected elements
- **Issue Categories**: ARIA, navigation, color contrast, forms, keyboard access, etc.
- **Critical Elements List**: Quick access to the most serious issues
- **Prioritized Recommendations**: Actionable advice in order of importance

## Performance Audit (`/performance-audit`)

The performance audit analyzes page load speed, Core Web Vitals, and optimization opportunities.

### Response Format

```json
{
  "metadata": {
    "url": "https://example.com",
    "timestamp": "2025-03-06T16:27:44.900Z",
    "device": "desktop",
    "lighthouseVersion": "11.7.1"
  },
  "report": {
    "score": 60,
    "audit_counts": {
      "failed": 11,
      "passed": 21,
      "manual": 0,
      "informative": 20,
      "not_applicable": 8
    },
    "metrics": [
      {
        "id": "lcp",
        "score": 0,
        "value_ms": 14149,
        "passes_core_web_vital": false,
        "element_selector": "div.heading > span",
        "element_type": "text",
        "element_content": "Welcome to Example"
      },
      {
        "id": "fcp",
        "score": 0.53,
        "value_ms": 1542,
        "passes_core_web_vital": false
      },
      {
        "id": "si",
        "score": 0,
        "value_ms": 6883
      },
      {
        "id": "tti",
        "score": 0,
        "value_ms": 14746
      },
      {
        "id": "cls",
        "score": 1,
        "value_ms": 0.001,
        "passes_core_web_vital": true
      },
      {
        "id": "tbt",
        "score": 1,
        "value_ms": 43,
        "passes_core_web_vital": true
      }
    ],
    "opportunities": [
      {
        "id": "render_blocking_resources",
        "savings_ms": 1270,
        "severity": "serious",
        "resources": [
          {
            "url": "styles.css",
            "savings_ms": 781
          }
        ]
      }
    ],
    "page_stats": {
      "total_size_kb": 2190,
      "total_requests": 108,
      "resource_counts": {
        "js": 86,
        "css": 1,
        "img": 3,
        "font": 3,
        "other": 15
      },
      "third_party_size_kb": 2110,
      "main_thread_blocking_time_ms": 693
    },
    "prioritized_recommendations": ["Improve Largest Contentful Paint (LCP)"]
  }
}
```

### Key Features

- **Core Web Vitals Analysis**: LCP, FCP, CLS, TBT with pass/fail status
- **Element Information for LCP**: Identifies what's causing the largest contentful paint
- **Optimization Opportunities**: Specific actions to improve performance with estimated time savings
- **Resource Breakdown**: By type, size, and origin (first vs. third party)
- **Main Thread Analysis**: Blocking time metrics to identify JavaScript performance issues
- **Resource-Specific Recommendations**: For each optimization opportunity

## SEO Audit (`/seo-audit`)

The SEO audit checks search engine optimization best practices and identifies issues that could affect search ranking.

### Response Format

```json
{
  "metadata": {
    "url": "https://example.com",
    "timestamp": "2025-03-06T16:29:12.455Z",
    "device": "desktop",
    "lighthouseVersion": "11.7.1"
  },
  "report": {
    "score": 91,
    "audit_counts": {
      "failed": 1,
      "passed": 10,
      "manual": 1,
      "informative": 0,
      "not_applicable": 3
    },
    "issues": [
      {
        "id": "is-crawlable",
        "title": "Page is blocked from indexing",
        "impact": "critical",
        "category": "crawlability",
        "score": 0
      }
    ],
    "categories": {
      "content": { "score": 0, "issues_count": 0 },
      "mobile": { "score": 0, "issues_count": 0 },
      "crawlability": { "score": 0, "issues_count": 1 },
      "other": { "score": 0, "issues_count": 0 }
    },
    "prioritized_recommendations": [
      "Fix crawlability issues (1 issues): robots.txt, sitemaps, and redirects"
    ]
  }
}
```

### Key Features

- **Issues Categorized by Impact**: Critical, serious, moderate, and minor
- **SEO Categories**: Content, mobile friendliness, crawlability
- **Issue Details**: Information about what's causing each SEO problem
- **Prioritized Recommendations**: Actionable advice in order of importance

## Best Practices Audit (`/best-practices-audit`)

The best practices audit evaluates adherence to web development best practices related to security, trust, user experience, and browser compatibility.

### Response Format

```json
{
  "metadata": {
    "url": "https://example.com",
    "timestamp": "2025-03-06T17:01:38.029Z",
    "device": "desktop",
    "lighthouseVersion": "11.7.1"
  },
  "report": {
    "score": 74,
    "audit_counts": {
      "failed": 4,
      "passed": 10,
      "manual": 0,
      "informative": 2,
      "not_applicable": 1
    },
    "issues": [
      {
        "id": "deprecations",
        "title": "Uses deprecated APIs",
        "impact": "critical",
        "category": "security",
        "score": 0,
        "details": [
          {
            "value": "UnloadHandler"
          }
        ]
      },
      {
        "id": "errors-in-console",
        "title": "Browser errors were logged to the console",
        "impact": "serious",
        "category": "user-experience",
        "score": 0,
        "details": [
          {
            "source": "console.error",
            "description": "ReferenceError: variable is not defined"
          }
        ]
      }
    ],
    "categories": {
      "security": { "score": 75, "issues_count": 1 },
      "trust": { "score": 100, "issues_count": 0 },
      "user-experience": { "score": 50, "issues_count": 1 },
      "browser-compat": { "score": 100, "issues_count": 0 },
      "other": { "score": 75, "issues_count": 2 }
    },
    "prioritized_recommendations": [
      "Address 1 security issues: vulnerabilities, CSP, deprecations",
      "Improve 1 user experience issues: console errors, user interactions"
    ]
  }
}
```

### Key Features

- **Issues Categorized by Impact**: Critical, serious, moderate, and minor
- **Best Practice Categories**: Security, trust, user experience, browser compatibility
- **Detailed Issue Information**: Specific problems affecting best practices compliance
- **Security Focus**: Special attention to security vulnerabilities and deprecated APIs
- **Prioritized Recommendations**: Actionable advice in order of importance

## License

MIT

# Puppeteer Service

A comprehensive browser automation service built on Puppeteer to provide reliable cross-platform browser control capabilities.

## Features

- **Cross-Platform Browser Support**:

  - Windows, macOS, and Linux support
  - Chrome, Edge, Brave, and Firefox detection
  - Fallback strategy for finding browser executables

- **Smart Browser Management**:

  - Singleton browser instance with automatic cleanup
  - Connection retry mechanisms
  - Temporary user data directories with cleanup

- **Rich Configuration Options**:
  - Custom browser paths
  - Network condition emulation
  - Device emulation (mobile, tablet, desktop)
  - Resource blocking
  - Cookies and headers customization
  - Locale and timezone emulation
