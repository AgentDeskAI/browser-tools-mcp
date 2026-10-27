/**
 * Guidance prompts.
 *
 * These were previously "tools" that took no input and returned a wall of
 * static text — including a ~700 line hardcoded Next.js checklist that made up
 * half of the MCP server file. Prompts are the protocol feature meant for
 * this, and they stay out of the tool list where they cost context on every
 * request.
 */

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  text: string;
}

const DEBUGGER_MODE = `You are debugging a live web page using BrowserTools MCP. Work through the
evidence before changing code.

1. Call getConnectionStatus first. If no extension is connected, stop and tell
   the user to open Chrome DevTools (F12) on the page they want inspected —
   nothing else will work until then.
2. Call getPageInfo to confirm which page is actually being inspected. If
   connectedTabs is above 1, call listBrowserTabs and pass an explicit tabId to
   every later call — otherwise the logs you read may come from a different page
   than the screenshot you take.
3. Gather evidence in this order, using the keyword and limit parameters to
   keep responses small:
   - getConsoleErrors for thrown exceptions and error-level output
   - getNetworkErrors for failed requests
   - getConsoleLogs with keywords when you have a specific term to chase
   - getSelectedElement if the user has highlighted something in the Elements panel
4. Form a hypothesis and say what evidence supports it. If the evidence is
   ambiguous, ask the user to reproduce with a narrower case rather than
   guessing.
5. Before proposing a fix, call wipeLogs, ask the user to reproduce the problem,
   then re-read the logs. A clean reproduction is worth more than a large
   quantity of stale output.
6. Propose the smallest change that addresses the root cause. Explain what you
   expect to see in the logs after the fix.

Never assume a log line is current — check timestamps against the reproduction.
Captured values are redacted where they looked like credentials; if a value
reads as [REDACTED] that is this tool protecting the user, not the application
misbehaving.

The 8-hour log is separate from the DevTools buffer and stays off until the
user enables a tab or a site in the extension popup. Call listTracked to see
what they enabled. Call getTimeline with chromeTabId or origin, and from/to
or lastMinutes. If reason is not-enabled or outside-window, the arrays are
empty on purpose. Do not fill that gap from getConsoleLogs, and do not guess
a different tab.`;

const AUDIT_MODE = `You are running a quality audit of a live page using BrowserTools MCP.

1. Call getPageInfo and confirm with the user that this is the page they want
   audited. If connectedTabs is above 1, call listBrowserTabs and name the tab
   explicitly.
2. Run the audits that match the user's concern rather than all four by reflex:
   - runAccessibilityAudit for screen-reader, contrast, and semantics issues
   - runPerformanceAudit for load and responsiveness metrics
   - runSEOAudit for indexability and metadata
   - runBestPracticesAudit for security and modern-web hygiene
3. Each report gives you a score, a summary count, and failing audits ordered by
   weight, with impact levels of critical, serious, moderate or minor. Detail
   items are capped for lower-impact issues; the omittedItems count tells you
   how much was withheld.
4. Report findings grouped by impact, highest first. For each, state the concrete
   change that fixes it and which elements or resources it affects.
5. Do not report a score without saying what would move it. A number alone is
   not actionable.

Audits launch a separate headless Chrome and take up to a minute. Run them one
at a time and tell the user what you are doing before you start.`;

const NEXTJS_SEO_AUDIT = `You are auditing a Next.js application for SEO using BrowserTools MCP.

Start with runSEOAudit against the live page to get measured findings, then
review the codebase for the Next.js specific causes behind them.

Metadata
- App Router: every route should export \`metadata\` or \`generateMetadata\`, with
  title, description, openGraph and canonical set. Check that dynamic routes
  generate per-page values rather than inheriting a single site-wide default.
- Pages Router: check next/head usage for the same fields, and that they are not
  duplicated across nested components.

Rendering and indexability
- Confirm content that matters for search is server-rendered, not client-only.
  A page whose body only appears after hydration will fail SEO audits.
- Check for unintended \`noindex\` in metadata or middleware.
- Verify \`app/sitemap.ts\` (or a generated sitemap) and \`app/robots.ts\` exist and
  reflect the real route set.

Structure and performance
- One h1 per page, headings in order, descriptive link text.
- next/image for images, with meaningful alt text and explicit sizes.
- next/font rather than external font links, to avoid render-blocking requests.
- Check the performance audit for LCP: in Next.js apps the usual causes are an
  unoptimised hero image, a client component that should be a server component,
  or a blocking third-party script that should use next/script with a
  non-blocking strategy.

Structured data
- Add JSON-LD where the content type warrants it, rendered server-side.

Report findings as concrete file-level changes, ordered by measured impact from
the audit rather than by checklist order.`;

export const PROMPTS: PromptDefinition[] = [
  {
    name: "debuggerMode",
    title: "Debug this page",
    description:
      "A systematic workflow for diagnosing a problem on the live page using console and network telemetry.",
    text: DEBUGGER_MODE,
  },
  {
    name: "auditMode",
    title: "Audit this page",
    description:
      "A workflow for running and interpreting accessibility, performance, SEO and best-practices audits.",
    text: AUDIT_MODE,
  },
  {
    name: "nextjsSeoAudit",
    title: "Next.js SEO audit",
    description:
      "SEO review tailored to Next.js applications, combining a live SEO audit with framework-specific causes.",
    text: NEXTJS_SEO_AUDIT,
  },
];
