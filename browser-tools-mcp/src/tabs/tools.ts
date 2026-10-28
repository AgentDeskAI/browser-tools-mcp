import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectorClient } from "../mcp/client.js";
import {
  ACT_ON_REF_DESCRIPTION,
  CHROME_TAB_ID,
  LIST_TABS_DESCRIPTION,
  NAVIGATE_TAB_DESCRIPTION,
  READ_TAB_DESCRIPTION,
  SNAPSHOT_TAB_DESCRIPTION,
  SOFT_CLICK_DESCRIPTION,
  SOFT_TYPE_DESCRIPTION,
} from "./contract.js";

type TextContent = { type: "text"; text: string };

export type TabToolResult = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(structured: Record<string, unknown>): TabToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(error: unknown): TabToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

const chromeTabIdInput = z.number().int().positive().describe(CHROME_TAB_ID);

const selectorInput = z
  .string()
  .min(1)
  .max(500)
  .describe("CSS selector for the element in that tab. Not a DevTools-connected tab id.");

const refInput = z
  .string()
  .regex(/^e[1-9][0-9]{0,4}$/)
  .describe("Stable ref from snapshotTab, such as e1. Not a chromeTabId or a DevTools-connected tabId.");

const semanticStateShape = z.object({
  disabled: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
  expanded: z.boolean().optional(),
  pressed: z.union([z.boolean(), z.literal("mixed")]).optional(),
  selected: z.boolean().optional(),
  required: z.boolean().optional(),
  invalid: z.boolean().optional(),
  readonly: z.boolean().optional(),
});

const semanticNodeShape = {
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  text: z.string(),
  state: semanticStateShape,
  visible: z.boolean(),
  depth: z.number().int(),
};

const pageDeltaShape = {
  urlChanged: z.boolean(),
  previousUrl: z.string(),
  url: z.string(),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.object({ url: z.string(), status: z.number().int().nullable() })),
};

const softOutcomeShape = {
  chromeTabId: z.number().int(),
  outcome: z.enum(["worked", "needs a real gesture"]),
  reason: z.string().nullable(),
  detail: z.string(),
  trusted: z.literal(false),
};

const safetyShape = {
  debuggerCalls: z.number().int(),
  focusChanges: z.number().int(),
};

const chromeTabShape = {
  chromeTabId: z.number().int().describe(CHROME_TAB_ID),
  windowId: z.number().int(),
  title: z.string(),
  url: z.string(),
  site: z.string().describe("Origin of the tab, or empty when the URL is not http(s)."),
  active: z.boolean(),
  pinned: z.boolean(),
  discarded: z.boolean().describe("Asleep. A read reports this and does not reload the tab."),
  frozen: z.boolean(),
  lastAccessed: z.number().nullable().describe("When the tab was last viewed, or null if the browser omitted it."),
  audible: z.boolean(),
  status: z.string(),
  index: z.number().int(),
};

const windowShape = {
  windowId: z.number().int(),
  focused: z.boolean(),
  type: z.string(),
  incognito: z.literal(false),
  tabs: z.array(z.object(chromeTabShape)),
};

export interface TabToolDefinition {
  name: string;
  register(server: McpServer, client: ConnectorClient): void;
}

function chromeTabIdFrom(args: Record<string, unknown>): number | undefined {
  const value = args["chromeTabId"];
  return typeof value === "number" ? value : undefined;
}

/**
 * Runs one chrome.tabs tool. Returns null for every other tool name so the
 * MCP server and the CLI share this path.
 */
export async function invokeTabTool(
  name: string,
  client: ConnectorClient,
  args: Record<string, unknown> = {}
): Promise<TabToolResult | null> {
  try {
    switch (name) {
      case "listTabs":
        return ok((await client.listChromeTabs()) as unknown as Record<string, unknown>);
      case "readTab": {
        const chromeTabId = chromeTabIdFrom(args);
        if (chromeTabId === undefined) return fail(new Error("chromeTabId is required"));
        return ok((await client.readChromeTab({ chromeTabId })) as unknown as Record<string, unknown>);
      }
      case "snapshotTab": {
        const chromeTabId = chromeTabIdFrom(args);
        if (chromeTabId === undefined) return fail(new Error("chromeTabId is required"));
        return ok((await client.snapshotChromeTab({ chromeTabId })) as unknown as Record<string, unknown>);
      }
      case "navigateTab": {
        const url = args["url"];
        if (typeof url !== "string" || !url.trim()) return fail(new Error("url is required"));
        const chromeTabId = chromeTabIdFrom(args);
        return ok(
          (await client.navigateChromeTab({
            url: url.trim(),
            ...(chromeTabId !== undefined ? { chromeTabId } : {}),
          })) as unknown as Record<string, unknown>
        );
      }
      case "softClick": {
        const chromeTabId = chromeTabIdFrom(args);
        const selector = args["selector"];
        if (chromeTabId === undefined || typeof selector !== "string") {
          return fail(new Error("chromeTabId and selector are required"));
        }
        return ok(
          (await client.softClickChromeTab({ chromeTabId, selector })) as unknown as Record<string, unknown>
        );
      }
      case "softType": {
        const chromeTabId = chromeTabIdFrom(args);
        const selector = args["selector"];
        const text = args["text"];
        if (chromeTabId === undefined || typeof selector !== "string" || typeof text !== "string") {
          return fail(new Error("chromeTabId, selector, and text are required"));
        }
        return ok(
          (await client.softTypeChromeTab({
            chromeTabId,
            selector,
            text,
            submit: args["submit"] === true,
          })) as unknown as Record<string, unknown>
        );
      }
      case "actOnRef": {
        const chromeTabId = chromeTabIdFrom(args);
        const ref = args["ref"];
        const op = args["op"];
        if (chromeTabId === undefined || typeof ref !== "string") {
          return fail(new Error("chromeTabId and ref are required"));
        }
        if (op !== "click" && op !== "type") return fail(new Error("op must be click or type"));
        const text = args["text"];
        if (op === "type" && typeof text !== "string") return fail(new Error("text is required"));
        return ok(
          (await client.actOnChromeTabRef({
            chromeTabId,
            ref,
            op,
            ...(op === "type" && typeof text === "string" ? { text, submit: args["submit"] === true } : {}),
          })) as unknown as Record<string, unknown>
        );
      }
      default:
        return null;
    }
  } catch (error) {
    return fail(error);
  }
}

export const TAB_TOOLS: TabToolDefinition[] = [
  {
    name: "listTabs",
    register(server, client) {
      server.registerTool(
        "listTabs",
        {
          title: "List tabs chrome.tabs can see",
          description: LIST_TABS_DESCRIPTION,
          outputSchema: {
            coverage: z.string(),
            visibleWindowId: z.number().int().nullable(),
            windows: z.array(z.object(windowShape)),
          },
          annotations: {
            title: "List tabs chrome.tabs can see",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async () => invokeTabTool("listTabs", client, {}) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "readTab",
    register(server, client) {
      server.registerTool(
        "readTab",
        {
          title: "Read a background tab",
          description: READ_TAB_DESCRIPTION,
          inputSchema: { chromeTabId: chromeTabIdInput },
          outputSchema: {
            chromeTabId: z.number().int(),
            url: z.string(),
            title: z.string(),
            site: z.string(),
            asleep: z.boolean(),
            frozen: z.boolean(),
            skipped: z.string().nullable(),
            headings: z.array(z.object({ level: z.number().int(), text: z.string() })),
            excerpt: z.string(),
            snapshot: z.array(z.object({ depth: z.number().int(), role: z.string(), name: z.string() })),
            hostAccess: z.boolean(),
          },
          annotations: {
            title: "Read a background tab",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("readTab", client, args) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "navigateTab",
    register(server, client) {
      server.registerTool(
        "navigateTab",
        {
          title: "Navigate in the background",
          description: NAVIGATE_TAB_DESCRIPTION,
          inputSchema: {
            url: z.string().describe("http(s) URL to load without focusing the tab or the window."),
            chromeTabId: chromeTabIdInput
              .optional()
              .describe(CHROME_TAB_ID + " Omit to open a new background tab in the visible window."),
          },
          outputSchema: {
            chromeTabId: z.number().int(),
            requestedUrl: z.string(),
            finalUrl: z.string(),
            wasDiscarded: z.boolean(),
            created: z.boolean(),
            visibleWindowId: z.number().int(),
            openedTabs: z.array(
              z.object({
                chromeTabId: z.number().int(),
                url: z.string(),
                windowId: z.number().int(),
                active: z.boolean(),
              })
            ),
            safety: z.object(safetyShape),
          },
          annotations: {
            title: "Navigate in the background",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("navigateTab", client, args) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "softClick",
    register(server, client) {
      server.registerTool(
        "softClick",
        {
          title: "Soft click",
          description: SOFT_CLICK_DESCRIPTION,
          inputSchema: { chromeTabId: chromeTabIdInput, selector: selectorInput },
          outputSchema: softOutcomeShape,
          annotations: {
            title: "Soft click",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("softClick", client, args) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "softType",
    register(server, client) {
      server.registerTool(
        "softType",
        {
          title: "Soft type",
          description: SOFT_TYPE_DESCRIPTION,
          inputSchema: {
            chromeTabId: chromeTabIdInput,
            selector: selectorInput,
            text: z.string().max(20000).describe("Text to insert. Password fields are refused."),
            submit: z
              .boolean()
              .optional()
              .describe("After a successful type, submit the surrounding form with requestSubmit()."),
          },
          outputSchema: softOutcomeShape,
          annotations: {
            title: "Soft type",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("softType", client, args) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "snapshotTab",
    register(server, client) {
      server.registerTool(
        "snapshotTab",
        {
          title: "Semantic page map",
          description: SNAPSHOT_TAB_DESCRIPTION,
          inputSchema: { chromeTabId: chromeTabIdInput },
          outputSchema: {
            chromeTabId: z.number().int(),
            url: z.string(),
            title: z.string(),
            site: z.string(),
            asleep: z.boolean(),
            frozen: z.boolean(),
            skipped: z.string().nullable(),
            hostAccess: z.boolean(),
            truncated: z.boolean(),
            nodes: z.array(z.object(semanticNodeShape)),
          },
          annotations: {
            title: "Semantic page map",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("snapshotTab", client, args) as Promise<TabToolResult>
      );
    },
  },
  {
    name: "actOnRef",
    register(server, client) {
      server.registerTool(
        "actOnRef",
        {
          title: "Act on a page ref",
          description: ACT_ON_REF_DESCRIPTION,
          inputSchema: {
            chromeTabId: chromeTabIdInput,
            ref: refInput,
            op: z.enum(["click", "type"]).describe("click or type. Type reuses the soft type path."),
            text: z.string().max(20000).optional().describe("Text to insert when op is type. Password fields are refused."),
            submit: z
              .boolean()
              .optional()
              .describe("After a successful type, submit the surrounding form with requestSubmit()."),
          },
          outputSchema: {
            ...softOutcomeShape,
            ref: z.string(),
            delta: z.object(pageDeltaShape),
          },
          annotations: {
            title: "Act on a page ref",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async (args) => invokeTabTool("actOnRef", client, args) as Promise<TabToolResult>
      );
    },
  },
];
