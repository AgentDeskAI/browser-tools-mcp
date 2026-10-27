import type { ConnectorClient } from "./client.js";
import {
  auditUri,
  consoleUri,
  harUri,
  networkUri,
  screenshotUri,
} from "./resources.js";
import type { AuditCategory } from "../lighthouse/types.js";
import { RestrictedPageError, restrictedPageToolText } from "../restricted-page.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    };

export type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function link(
  uri: string,
  name: string,
  description: string,
  mimeType = "application/json"
): ToolContent {
  return { type: "resource_link", uri, name, description, mimeType };
}

function ok(structured: Record<string, unknown>, extraContent: ToolContent[] = []): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extraContent],
    structuredContent: structured,
  };
}

function fail(error: unknown): ToolResult {
  if (error instanceof RestrictedPageError) {
    return { content: [{ type: "text", text: restrictedPageToolText(error) }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

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

function tabIdFrom(args: Record<string, unknown>): number | string | undefined {
  const tabId = args["tabId"];
  if (typeof tabId === "number" || typeof tabId === "string") return tabId;
  return undefined;
}

/**
 * Runs one MCP tool by name. Kept in step with the MCP server's tool list —
 * parity tests fail when a tool is added on one side and not the other.
 */
export async function invokeTool(
  name: string,
  client: ConnectorClient,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  switch (name) {
    case "listBrowserTabs":
      try {
        return ok((await client.tabs()) as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(error);
      }
    case "getConsoleLogs":
      try {
        const result = await client.console({ ...args });
        return ok(result as unknown as Record<string, unknown>, truncationLinks(result));
      } catch (error) {
        return fail(error);
      }
    case "getConsoleErrors":
      try {
        const result = await client.console({ ...args, errorsOnly: true });
        return ok(result as unknown as Record<string, unknown>, truncationLinks(result));
      } catch (error) {
        return fail(error);
      }
    case "getNetworkLogs":
      try {
        const result = await client.network({ ...args });
        return ok(result as unknown as Record<string, unknown>, networkLinks(result));
      } catch (error) {
        return fail(error);
      }
    case "getNetworkErrors":
      try {
        const result = await client.network({ ...args, errorsOnly: true });
        return ok(result as unknown as Record<string, unknown>, networkLinks(result));
      } catch (error) {
        return fail(error);
      }
    case "getSelectedElement":
      try {
        const tabId = tabIdFrom(args);
        const element = (await client.selectedElement(
          tabId !== undefined ? { tabId } : {}
        )) as Record<string, unknown> | null;
        return ok({ element });
      } catch (error) {
        return fail(error);
      }
    case "getPageInfo":
      try {
        return ok((await client.page()) as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(error);
      }
    case "getConnectionStatus":
      try {
        return ok((await client.status()) as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(error);
      }
    case "takeScreenshot": {
      try {
        const nameArg = typeof args["name"] === "string" ? args["name"] : undefined;
        const tabId = tabIdFrom(args);
        const result = await client.screenshot({
          ...(nameArg ? { name: nameArg } : {}),
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
    case "refreshBrowser":
      try {
        const tabId = tabIdFrom(args);
        await client.refresh(tabId !== undefined ? { tabId } : {});
        return ok({ ok: true });
      } catch (error) {
        return fail(error);
      }
    case "navigateBrowser": {
      try {
        const url = args["url"];
        if (typeof url !== "string" || !url.trim()) {
          return fail(new Error("url is required"));
        }
        const tabId = tabIdFrom(args);
        const result = await client.navigate({
          url: url.trim(),
          ...(tabId !== undefined ? { tabId } : {}),
        });
        return ok(result as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(error);
      }
    }
    case "getBrowserStorage": {
      try {
        const kinds = Array.isArray(args["kinds"])
          ? (args["kinds"] as string[])
          : undefined;
        const includeValues = args["includeValues"] === true;
        const tabId = tabIdFrom(args);
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
    case "wipeLogs":
      try {
        const tabId = tabIdFrom(args);
        await client.wipe(tabId !== undefined ? { tabId } : {});
        return ok({ ok: true });
      } catch (error) {
        return fail(error);
      }
    case "runAccessibilityAudit":
      return runAudit(client, "accessibility", args);
    case "runPerformanceAudit":
      return runAudit(client, "performance", args);
    case "runSEOAudit":
      return runAudit(client, "seo", args);
    case "runBestPracticesAudit":
      return runAudit(client, "best-practices", args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runAudit(
  client: ConnectorClient,
  category: AuditCategory,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const url = typeof args["url"] === "string" ? args["url"] : undefined;
    const tabId = tabIdFrom(args);
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

/** Every registered MCP tool name must have an invoke implementation. */
export const INVOKABLE_TOOL_NAMES: readonly string[] = [
  "listBrowserTabs",
  "getConsoleLogs",
  "getConsoleErrors",
  "getNetworkLogs",
  "getNetworkErrors",
  "getSelectedElement",
  "getPageInfo",
  "getConnectionStatus",
  "takeScreenshot",
  "refreshBrowser",
  "navigateBrowser",
  "getBrowserStorage",
  "wipeLogs",
  "runAccessibilityAudit",
  "runPerformanceAudit",
  "runSEOAudit",
  "runBestPracticesAudit",
];
