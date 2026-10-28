import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectorClient } from "../mcp/client.js";
import { CHROME_TAB_ID } from "../tabs/contract.js";

type TextContent = { type: "text"; text: string };

export type TimelineToolResult = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(structured: Record<string, unknown>): TimelineToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(error: unknown): TimelineToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

const LIST_TRACKED_DESCRIPTION =
  "Tabs and origins the user has turned on for the local 8-hour log. " +
  "Tracking is off until they enable a tab or a site in the extension popup. " +
  "An empty list means nothing is being recorded. This does not attach the debugger, " +
  "does not hide the debugging banner, and does not read the DevTools log buffer.";

const GET_TIMELINE_DESCRIPTION =
  "Redacted console and network for one chromeTabId or one origin, between from and to " +
  "(ISO times or epoch milliseconds) or over lastMinutes. The log is local, kept for a " +
  "rolling 8 hours, then dropped. Cookie and Authorization values are removed before storage. " +
  "If that tab or origin was never enabled, or the time range is outside the 8-hour window, " +
  "console and network are empty and reason says not-enabled or outside-window. " +
  "This does not guess from getConsoleLogs or any other tab. " +
  "It does not attach the debugger and does not hide the debugging banner. " +
  "wipeLogs does not clear this log.";

const consoleEntry = z.object({
  kind: z.literal("console"),
  chromeTabId: z.number().int(),
  origin: z.string(),
  url: z.string(),
  level: z.string(),
  message: z.string(),
  timestamp: z.number(),
});

const networkEntry = z.object({
  kind: z.literal("network"),
  chromeTabId: z.number().int(),
  origin: z.string(),
  url: z.string(),
  method: z.string(),
  status: z.number().int(),
  timestamp: z.number(),
  startedAt: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  requestBody: z.string().optional(),
});

const targetShape = {
  kind: z.enum(["tab", "origin"]),
  chromeTabId: z.number().int().nullable(),
  origin: z.string(),
  url: z.string(),
  title: z.string(),
  enabledAt: z.number(),
  enabled: z.boolean(),
};

const timelineOutput = {
  tracked: z.boolean().describe("False when this tab or origin was never enabled."),
  reason: z.enum(["ok", "not-enabled", "outside-window", "none-in-range"]),
  chromeTabId: z.number().int().nullable(),
  origin: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  windowStart: z.string().describe("Start of the rolling 8-hour window."),
  retentionHours: z.number().int(),
  localOnly: z.literal(true),
  clipped: z.boolean().describe("True when the requested range extended outside the window and was cut to it."),
  console: z.array(consoleEntry),
  network: z.array(networkEntry),
  consoleTotal: z.number().int(),
  networkTotal: z.number().int(),
  truncated: z.boolean(),
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export interface TimelineToolDefinition {
  name: string;
  register(server: McpServer, client: ConnectorClient): void;
}

function timeArg(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function queryFromArgs(args: Record<string, unknown>) {
  const from = timeArg(args["from"]);
  const to = timeArg(args["to"]);
  return {
    ...(typeof args["chromeTabId"] === "number" ? { chromeTabId: args["chromeTabId"] } : {}),
    ...(typeof args["origin"] === "string" ? { origin: args["origin"] } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(typeof args["lastMinutes"] === "number" ? { lastMinutes: args["lastMinutes"] } : {}),
    ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
  };
}

/**
 * Runs one timeline tool. Returns null for every other tool name so the MCP
 * server and the CLI share this path.
 */
export async function invokeTimelineTool(
  name: string,
  client: ConnectorClient,
  args: Record<string, unknown> = {}
): Promise<TimelineToolResult | null> {
  try {
    switch (name) {
      case "listTracked":
        return ok((await client.listTracked()) as unknown as Record<string, unknown>);
      case "getTimeline":
        return ok((await client.getTimeline(queryFromArgs(args))) as unknown as Record<string, unknown>);
      default:
        return null;
    }
  } catch (error) {
    return fail(error);
  }
}

export const TIMELINE_TOOLS: TimelineToolDefinition[] = [
  {
    name: "listTracked",
    register(server, client) {
      server.registerTool(
        "listTracked",
        {
          title: "List tracked tabs and origins",
          description: LIST_TRACKED_DESCRIPTION,
          outputSchema: {
            retentionHours: z.number().int(),
            windowStart: z.string(),
            localOnly: z.literal(true),
            targets: z.array(z.object(targetShape)),
          },
          annotations: { title: "List tracked tabs and origins", ...readOnly },
        },
        async () => invokeTimelineTool("listTracked", client, {}) as Promise<TimelineToolResult>
      );
    },
  },
  {
    name: "getTimeline",
    register(server, client) {
      server.registerTool(
        "getTimeline",
        {
          title: "Get 8-hour tab timeline",
          description: GET_TIMELINE_DESCRIPTION,
          inputSchema: {
            chromeTabId: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(`${CHROME_TAB_ID} The tab the user enabled, or a tab on an enabled origin.`),
            origin: z
              .string()
              .optional()
              .describe(
                "http(s) origin the user enabled, such as https://billing.example:443. Default ports are included."
              ),
            from: z
              .union([z.string(), z.number()])
              .optional()
              .describe("Range start, as an ISO time or epoch milliseconds."),
            to: z
              .union([z.string(), z.number()])
              .optional()
              .describe("Range end, as an ISO time or epoch milliseconds."),
            lastMinutes: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Instead of from/to, the last N minutes ending now."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(500)
              .optional()
              .describe("Maximum console entries and maximum network entries. Defaults to 100."),
          },
          outputSchema: timelineOutput,
          annotations: { title: "Get 8-hour tab timeline", ...readOnly },
        },
        async (args) => invokeTimelineTool("getTimeline", client, args) as Promise<TimelineToolResult>
      );
    },
  },
];
