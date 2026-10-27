import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectorClient } from "./client.js";
import { PROMPTS } from "./prompts.js";
import {
  auditUri,
  consoleUri,
  harUri,
  networkUri,
  registerResources,
  screenshotUri,
} from "./resources.js";
import { resolveEnabledTools } from "../connector/api-policy.js";
import { createLogger } from "../util/logger.js";
import { AUDIT_CATEGORIES, type AuditCategory } from "../lighthouse/types.js";
import {
  RESTRICTED_PAGE_KINDS,
  RESTRICTED_PAGE_MESSAGE,
  RestrictedPageError,
  restrictedPageToolText,
} from "../restricted-page.js";

const log = createLogger("mcp");

export const SERVER_NAME = "browser-tools-mcp";
export const SERVER_VERSION = "2.0.0";

export interface McpServerOptions {
  client: ConnectorClient;
  /** When set, only these tools are exposed. Unknown names are ignored. */
  enabledTools?: string[];
  /** Tools to hide. Applied after enabledTools. */
  disabledTools?: string[];
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};
type ToolContent = TextContent | ImageContent | ResourceLink;

/**
 * A pointer to the unabridged data, for when a result had to be cut down.
 * Cheap to include, and the client only fetches it if it decides to.
 */
function link(
  uri: string,
  name: string,
  description: string,
  mimeType = "application/json"
): ResourceLink {
  return { type: "resource_link", uri, name, description, mimeType };
}

type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Spec-compliant success result: structured data plus its serialisation as
 * text, so clients that only render content blocks still see the payload.
 */
function ok(structured: Record<string, unknown>, extraContent: ToolContent[] = []): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extraContent],
    structuredContent: structured,
  };
}

function fail(error: unknown): ToolResult {
  if (error instanceof RestrictedPageError) {
    log.warn("Tool call failed:", error.message);
    // Text carries the JSON. structuredContent is omitted: clients validate it
    // against the success output schema and would reject this shape.
    return { content: [{ type: "text", text: restrictedPageToolText(error) }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  log.warn("Tool call failed:", message);
  return { content: [{ type: "text", text: message }], isError: true };
}

const restrictedPageOutput = {
  access: z
    .literal("metadata-only")
    .optional()
    .describe(`Set when this page cannot be scripted. The message is "${RESTRICTED_PAGE_MESSAGE}".`),
  message: z.string().optional().describe("Shared wording for a page that cannot be scripted"),
  scriptable: z.literal(false).optional().describe("False when the page cannot be read or acted on"),
  kind: z.enum(RESTRICTED_PAGE_KINDS).optional(),
  detail: z.string().optional().describe("Which kind of page cannot be scripted"),
};

/** Offers the complete history whenever a read had to be cut short. */
function truncationLinks(result: { truncated: boolean; tabId: unknown }): ToolContent[] {
  if (!result.truncated) return [];
  const tabId = result.tabId as string | number | null;
  return [
    link(
      consoleUri(tabId),
      "console-history",
      "Every captured console entry, without the per-call size budget"
    ),
  ];
}

/** Network reads always offer a HAR; the full history only when clipped. */
function networkLinks(result: {
  truncated: boolean;
  total: number;
  tabId: unknown;
}): ToolContent[] {
  const tabId = result.tabId as string | number | null;
  const links: ToolContent[] = [];
  if (result.total > 0) {
    links.push(
      link(harUri(tabId), "network-har", "This tab's network activity as a HAR file")
    );
  }
  if (result.truncated) {
    links.push(
      link(
        networkUri(tabId),
        "network-history",
        "Every captured request, without the per-call size budget"
      )
    );
  }
  return links;
}

const queryOutputShape = {
  entries: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().describe("Entries matching the filter before paging"),
  returned: z.number().int().describe("Entries actually included"),
  truncated: z.boolean().describe("True when some matching entries were withheld"),
  tabId: z
    .union([z.number(), z.string()])
    .nullable()
    .describe("The tab these entries came from, or null when reading every tab"),
  url: z.string().describe("The page that tab is on"),
  otherTabs: z
    .number()
    .int()
    .describe("Connected tabs NOT covered here. If above 0, call listBrowserTabs."),
};

/**
 * Deliberately a numeric/string id rather than a name or url fragment: two tabs
 * can sit on the same url, and a substring selector silently retargets when a
 * page navigates.
 */
const tabIdInput = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe(
    "Which browser tab to use, from listBrowserTabs. Omit to use the current tab — the " +
      "one DevTools was most recently opened on, which is right in almost every session. " +
      "Only pass this when a result reported otherTabs above 0 and you need a specific tab."
  );

const allTabsInput = z
  .boolean()
  .optional()
  .describe("Read every connected tab at once instead of just the current one.");

const tabScopeInputShape = { tabId: tabIdInput, allTabs: allTabsInput };

const pagingInputShape = {
  limit: z.number().int().min(1).max(1000).optional().describe("Maximum entries to return"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How many of the most recent entries to skip, for paging backwards"),
};

const keywordInput = z
  .array(z.string())
  .optional()
  .describe("Case-insensitive substrings; an entry matches if it contains any of them");

const auditOutputShape = {
  category: z.string(),
  score: z.number().nullable().describe("0-100, or null if the category was not measured"),
  metadata: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.number()),
  issues: z.array(z.record(z.string(), z.unknown())),
  groups: z.record(z.string(), z.unknown()).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
};

interface ToolDefinition {
  name: string;
  register(server: McpServer, client: ConnectorClient): void;
}

function auditTool(
  name: string,
  category: AuditCategory,
  title: string,
  description: string
): ToolDefinition {
  return {
    name,
    register(server, client) {
      server.registerTool(
        name,
        {
          title,
          description,
          inputSchema: {
            url: z
              .string()
              .optional()
              .describe(
                "Page to audit. Defaults to the page currently open in the browser. Pages on " +
                  "localhost or a private network can only be audited while open in a connected tab."
              ),
            tabId: tabIdInput,
          },
          outputSchema: auditOutputShape,
          annotations: {
            title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({ url, tabId }) => {
          try {
            const report = await client.audit(category, {
              ...(url ? { url } : {}),
              ...(tabId !== undefined ? { tabId } : {}),
            });
            return ok(
              report as unknown as Record<string, unknown>,
              report.reportId
                ? [
                    link(
                      auditUri(report.reportId),
                      `${category}-report`,
                      "The unabridged Lighthouse result behind this summary"
                    ),
                  ]
                : []
            );
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "listBrowserTabs",
    register(server, client) {
      server.registerTool(
        "listBrowserTabs",
        {
          title: "List browser tabs",
          description:
            "Every browser tab that currently has DevTools open, with the tabId you can pass to any other tool. " +
            "Call this when a result reported otherTabs above 0, or when the user mentions a page other than the one you have been reading. " +
            "The tab marked isCurrent is the one every other tool uses when you do not pass tabId. " +
            "A tab on chrome://, DevTools, view-source, the Chrome Web Store, an extension page, or the PDF viewer " +
            `is metadata only (access "metadata-only", "${RESTRICTED_PAGE_MESSAGE}") and cannot be scripted.`,
          outputSchema: {
            tabs: z.array(z.record(z.string(), z.unknown())),
            currentTabId: z.union([z.number(), z.string()]).nullable(),
            connectedTabs: z.number().int(),
          },
          annotations: {
            title: "List browser tabs",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            return ok((await client.tabs()) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getConsoleLogs",
    register(server, client) {
      server.registerTool(
        "getConsoleLogs",
        {
          title: "Get console logs",
          description:
            "Console output from the current tab. Use keywords and limit to keep responses small — an unfiltered read can be large. Pass tabId for a different tab, or allTabs to read every tab; the result reports which tab it came from.",
          inputSchema: { keywords: keywordInput, ...tabScopeInputShape, ...pagingInputShape },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get console logs",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const result = await client.console({ ...args });
            return ok(result as unknown as Record<string, unknown>, truncationLinks(result));
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getConsoleErrors",
    register(server, client) {
      server.registerTool(
        "getConsoleErrors",
        {
          title: "Get console errors",
          description:
            "Only error-level console output and uncaught exceptions from the current tab. Start here when diagnosing a failure. Pass tabId for a different tab, or allTabs to read every tab.",
          inputSchema: { keywords: keywordInput, ...tabScopeInputShape, ...pagingInputShape },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get console errors",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const result = await client.console({ ...args, errorsOnly: true });
            return ok(result as unknown as Record<string, unknown>, truncationLinks(result));
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getNetworkLogs",
    register(server, client) {
      server.registerTool(
        "getNetworkLogs",
        {
          title: "Get network requests",
          description:
            "XHR and fetch requests from the current tab, including status and timing. Credential headers are redacted. Pass tabId for a different tab, or allTabs to read every tab.",
          inputSchema: {
            urlKeywords: z.array(z.string()).optional().describe("Match against the request URL"),
            bodyKeywords: z
              .array(z.string())
              .optional()
              .describe("Match against the request or response body"),
            ...tabScopeInputShape,
            ...pagingInputShape,
          },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get network requests",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const result = await client.network({ ...args });
            return ok(result as unknown as Record<string, unknown>, networkLinks(result));
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getNetworkErrors",
    register(server, client) {
      server.registerTool(
        "getNetworkErrors",
        {
          title: "Get failed network requests",
          description:
            "Only requests that failed or returned a 4xx/5xx status. An empty result means there were no failures, which is a success, not an error.",
          inputSchema: {
            urlKeywords: z.array(z.string()).optional().describe("Match against the request URL"),
            ...tabScopeInputShape,
            ...pagingInputShape,
          },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get failed network requests",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const result = await client.network({ ...args, errorsOnly: true });
            return ok(result as unknown as Record<string, unknown>, networkLinks(result));
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getSelectedElement",
    register(server, client) {
      server.registerTool(
        "getSelectedElement",
        {
          title: "Get selected element",
          description:
            "The DOM element the user has selected in the Chrome DevTools Elements panel, with its attributes and markup.",
          inputSchema: { tabId: tabIdInput },
          outputSchema: { element: z.record(z.string(), z.unknown()).nullable() },
          annotations: {
            title: "Get selected element",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ tabId }) => {
          try {
            const element = (await client.selectedElement(
              tabId !== undefined ? { tabId } : {}
            )) as Record<string, unknown> | null;
            return ok({ element });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getPageInfo",
    register(server, client) {
      server.registerTool(
        "getPageInfo",
        {
          title: "Get current page",
          description:
            "Which page the browser is currently on. Call this before reading telemetry so you know what the logs describe. If connectedTabs is above 1, call listBrowserTabs before assuming this is the page the user means. " +
            `When the page cannot be scripted, access is "metadata-only" and message is "${RESTRICTED_PAGE_MESSAGE}".`,
          outputSchema: {
            url: z.string(),
            tabId: z.union([z.number(), z.string()]).nullable(),
            extensionConnected: z.boolean(),
            connectedTabs: z
              .number()
              .int()
              .describe("How many tabs have DevTools open. Above 1 means other pages exist."),
            ...restrictedPageOutput,
          },
          annotations: {
            title: "Get current page",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            return ok((await client.page()) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getConnectionStatus",
    register(server, client) {
      server.registerTool(
        "getConnectionStatus",
        {
          title: "Check browser connection",
          description:
            "Whether the Chrome extension is connected and how much telemetry has been captured. Call this first when something returns nothing.",
          outputSchema: {
            version: z.string(),
            extensionConnected: z.boolean(),
            connections: z.number().int(),
            tabs: z.number().int(),
            currentTabId: z.union([z.number(), z.string()]).nullable(),
            screenshotDir: z.string(),
            counts: z.record(z.string(), z.number()),
          },
          annotations: {
            title: "Check browser connection",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            return ok((await client.status()) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "takeScreenshot",
    register(server, client) {
      server.registerTool(
        "takeScreenshot",
        {
          title: "Take a screenshot",
          description:
            "Captures the visible area of the current tab and returns the image directly, plus the path it was saved to and the url captured. Pass tabId to capture a different tab.",
          inputSchema: {
            name: z
              .string()
              .optional()
              .describe("Filename to save as, relative to the screenshot directory"),
            tabId: tabIdInput,
          },
          outputSchema: {
            path: z.string(),
            name: z.string(),
            mimeType: z.string(),
            bytes: z.number().int(),
            imageIncluded: z.boolean(),
            tabId: z.union([z.number(), z.string()]).nullable(),
            url: z.string().describe("The page captured — check this is the one you meant"),
          },
          annotations: {
            title: "Take a screenshot",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async ({ name, tabId }) => {
          try {
            const result = await client.screenshot({
              ...(name ? { name } : {}),
              ...(tabId !== undefined ? { tabId } : {}),
            });
            const base64 = result.data.replace(/^data:[^;]+;base64,/, "");
            const structured = {
              path: result.path,
              name: result.name,
              mimeType: result.mimeType,
              bytes: result.bytes,
              imageIncluded: result.withinBudget,
              tabId: result.tabId ?? null,
              url: result.url ?? "",
            };

            // An oversized image is left on disk rather than inlined: it would
            // swamp the context window, and newer MCP stdio transports drop the
            // connection outright past their read buffer.
            const asResource = link(
              screenshotUri(result.name),
              result.name,
              "The captured screenshot",
              result.mimeType
            );

            if (!result.withinBudget) {
              return ok(structured, [
                {
                  type: "text",
                  text:
                    `The screenshot is ${Math.round(result.bytes / 1024)} KB, too large to include here. ` +
                    `It was saved to ${result.path} and can be read from the linked resource.`,
                },
                asResource,
              ]);
            }

            return ok(structured, [
              { type: "image", data: base64, mimeType: result.mimeType },
              asResource,
            ]);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "navigateBrowser",
    register(server, client) {
      server.registerTool(
        "navigateBrowser",
        {
          title: "Navigate to a URL",
          description:
            "Loads a URL in the chosen browser tab without focusing it or attaching the debugger. " +
            "Uses the tabId from listBrowserTabs. Requires the extension service worker, the popup " +
            "switch, and --allow-input on browser-tools-mcp (browser-tools CLI: --allow-actions). " +
            "chrome://, DevTools, view-source, the Chrome Web Store, and extension pages are refused. " +
            "An http(s) PDF may load, then the tool fails because the viewer cannot be scripted. " +
            `The error text is JSON with access "metadata-only" and message "${RESTRICTED_PAGE_MESSAGE}".`,
          inputSchema: {
            url: z.string().describe("http(s) URL to load in the tab"),
            tabId: tabIdInput,
          },
          outputSchema: {
            tabId: z.union([z.number(), z.string()]),
            requestedUrl: z.string(),
            finalUrl: z.string(),
            wasDiscarded: z.boolean(),
          },
          annotations: {
            title: "Navigate to a URL",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({ url, tabId }) => {
          try {
            const result = await client.navigate({
              url,
              ...(tabId !== undefined ? { tabId } : {}),
            });
            return ok(result as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "refreshBrowser",
    register(server, client) {
      server.registerTool(
        "refreshBrowser",
        {
          title: "Reload the page",
          description:
            "Reloads the inspected tab. Useful for capturing a clean reproduction after calling wipeLogs.",
          inputSchema: { tabId: tabIdInput },
          outputSchema: { ok: z.boolean() },
          annotations: {
            title: "Reload the page",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async ({ tabId }) => {
          try {
            await client.refresh(tabId !== undefined ? { tabId } : {});
            return ok({ ok: true });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getBrowserStorage",
    register(server, client) {
      server.registerTool(
        "getBrowserStorage",
        {
          title: "Inspect browser storage",
          description:
            "Lists localStorage, sessionStorage and cookie entries for the current page. Values are withheld unless includeValues is set, because they routinely contain session tokens.",
          inputSchema: {
            kinds: z
              .array(z.enum(["localStorage", "sessionStorage", "cookies"]))
              .optional()
              .describe("Which stores to read. Defaults to localStorage and sessionStorage."),
            includeValues: z
              .boolean()
              .optional()
              .describe(
                "Return the actual values. Only set this when the user has asked for them — these are credentials."
              ),
            tabId: tabIdInput,
          },
          outputSchema: {
            storage: z.record(z.string(), z.unknown()),
            includedValues: z.boolean(),
          },
          annotations: {
            title: "Inspect browser storage",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ kinds, includeValues, tabId }) => {
          try {
            const requested = kinds?.length ? kinds : ["localStorage", "sessionStorage"];
            const raw = await client.storage(requested, tabId !== undefined ? { tabId } : {});
            return ok({
              storage: includeValues ? raw : summariseStorage(raw),
              includedValues: Boolean(includeValues),
            });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "wipeLogs",
    register(server, client) {
      server.registerTool(
        "wipeLogs",
        {
          title: "Clear captured telemetry",
          description:
            "Discards captured console and network entries for every tab, or one tab if you name it. Use before reproducing a problem so the next read contains only relevant output.",
          inputSchema: { tabId: tabIdInput },
          outputSchema: { ok: z.boolean() },
          annotations: {
            title: "Clear captured telemetry",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ tabId }) => {
          try {
            await client.wipe(tabId !== undefined ? { tabId } : {});
            return ok({ ok: true });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  auditTool(
    "runAccessibilityAudit",
    "accessibility",
    "Run an accessibility audit",
    "Lighthouse accessibility audit of the current page: contrast, labels, semantics and screen-reader support. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runPerformanceAudit",
    "performance",
    "Run a performance audit",
    "Lighthouse performance audit of the current page, including Core Web Vitals. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runSEOAudit",
    "seo",
    "Run an SEO audit",
    "Lighthouse SEO audit of the current page: metadata, indexability and crawlability. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runBestPracticesAudit",
    "best-practices",
    "Run a best-practices audit",
    "Lighthouse best-practices audit of the current page: security, deprecated APIs and modern-web hygiene. Takes up to a minute and launches a separate headless browser."
  ),
];

export const ALL_TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** Hides values while still showing which keys exist. */
function summariseStorage(storage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [kind, value] of Object.entries(storage)) {
    if (Array.isArray(value)) {
      const names = value
        .map((item) =>
          item && typeof item === "object" && "name" in item ? String((item as any).name) : null
        )
        .filter((name): name is string => Boolean(name));
      out[kind] = { names, count: value.length };
    } else if (value && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      out[kind] = { keys, count: keys.length };
    } else {
      out[kind] = { keys: [], count: 0 };
    }
  }

  return out;
}

export function createMcpServer(options: McpServerOptions): {
  server: McpServer;
  toolNames: string[];
} {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );

  const toolFilter = resolveEnabledTools(ALL_TOOL_NAMES, options.enabledTools, options.disabledTools);
  const selected = TOOLS.filter((tool) => toolFilter.enabled.has(tool.name));

  if (toolFilter.unknown.length > 0) {
    log.warn(`Ignoring unknown tool name(s) in filter: ${toolFilter.unknown.join(", ")}`);
  }

  for (const tool of selected) tool.register(server, options.client);

  registerResources(server, options.client);

  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description },
      () => ({
        messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
      })
    );
  }

  log.info(
    `Registered ${selected.length} tools, ${PROMPTS.length} prompts and 5 resource templates`
  );

  return { server, toolNames: selected.map((tool) => tool.name) };
}

export { AUDIT_CATEGORIES };
