import { parseCli, readPackageVersion, type CliOptions } from "./cli.js";
import { createRuntime } from "./runtime.js";
import { invokeTool, INVOKABLE_TOOL_NAMES } from "./mcp/tool-invoke.js";
import { ALL_TOOL_NAMES } from "./mcp/server.js";
import {
  ALL_RESOURCE_COMMANDS,
  fetchResource,
  type ResourceCommandName,
} from "./mcp/resource-cli.js";

export interface ToolsCliParseResult {
  options: CliOptions;
  command?: string;
  argsJson: string;
}

/**
 * Parses argv for the browser-tools CLI.
 *
 * Capability gating uses `--allow-actions` only (maps to connector `--allow-input`).
 * The MCP server binary keeps separate `--allow-eval` / `--allow-input` flags.
 */
export function parseToolsCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ToolsCliParseResult {
  let allowActions = false;
  const connectorArgv: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--allow-actions") {
      allowActions = true;
      continue;
    }
    if (arg.startsWith("--allow-eval") || arg.startsWith("--allow-input")) {
      throw new Error(
        "browser-tools uses --allow-actions for navigation and other input, not --allow-eval or --allow-input"
      );
    }
    connectorArgv.push(arg);
  }

  const parsed = parseCli(connectorArgv, env);
  if (allowActions) {
    parsed.allowInput = true;
  }

  const positional: string[] = [];
  for (let i = 0; i < connectorArgv.length; i++) {
    const arg = connectorArgv[i]!;
    if (arg.startsWith("-")) {
      if (
        arg === "--port" ||
        arg === "--host" ||
        arg === "--screenshot-dir" ||
        arg === "--connect" ||
        arg === "--token" ||
        arg === "--only" ||
        arg === "--exclude" ||
        arg === "--audit-allow-origin" ||
        arg === "--allow-input-origins" ||
        arg === "--exclude-origins" ||
        arg === "--extension-id"
      ) {
        i++;
      }
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0];
  const argsJson = positional[1] ?? "{}";
  return { options: parsed, ...(command ? { command } : {}), argsJson };
}

export function toolsHelpText(): string {
  return `BrowserTools CLI — mirror of the Browser Tools MCP server

Usage:
  browser-tools [connector options] <command> ['{"arg":"value"}']

Connector options match browser-tools-mcp except capability gating:
  --allow-actions          Allow navigation and other input (maps to connector input policy).
                           Not --allow-eval / --allow-input. No environment variable.
  --allow-input-origins, --exclude-origins, --connect, --token, --port, …

Tool commands (same names and JSON args as the MCP tools):
  ${ALL_TOOL_NAMES.join(", ")}

Resource commands:
  browser-tools resource <name> <scope>
  Names: ${ALL_RESOURCE_COMMANDS.join(", ")}

Examples:
  browser-tools getConnectionStatus
  browser-tools getConsoleLogs '{"limit":20}'
  browser-tools --allow-actions navigateBrowser '{"url":"http://localhost:3000/","tabId":1}'
`;
}

export async function runToolsCli(argv: string[]): Promise<number> {
  let parsed: ToolsCliParseResult;
  try {
    parsed = parseToolsCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const { options, command, argsJson } = parsed;

  if (options.showVersion) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (options.showHelp || !command) {
    process.stdout.write(toolsHelpText());
    return command ? 0 : options.showHelp ? 0 : 1;
  }

  let args: Record<string, unknown> = {};
  if (command !== "resource" && argsJson.trim()) {
    try {
      const value = JSON.parse(argsJson) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        args = value as Record<string, unknown>;
      } else {
        process.stderr.write("Tool arguments must be a JSON object\n");
        return 1;
      }
    } catch (error) {
      process.stderr.write(
        `Could not parse tool arguments as JSON: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
  }

  const runtime = await createRuntime(options);
  try {
    if (command === "resource") {
      const parts = argsJson.trim().split(/\s+/);
      const resourceName = parts[0] as ResourceCommandName | undefined;
      const scope = parts.slice(1).join(" ") || "all";
      if (!resourceName || !ALL_RESOURCE_COMMANDS.includes(resourceName)) {
        process.stderr.write(`Unknown resource. Choose one of: ${ALL_RESOURCE_COMMANDS.join(", ")}\n`);
        return 1;
      }
      const payload = await fetchResource(resourceName, runtime.client, scope);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }

    if (!INVOKABLE_TOOL_NAMES.includes(command) && !ALL_TOOL_NAMES.includes(command)) {
      process.stderr.write(`Unknown command: ${command}\n`);
      return 1;
    }

    const result = await invokeTool(command, runtime.client, args);
    if (result.structuredContent) {
      process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
    } else if (result.content[0]?.type === "text") {
      process.stdout.write(`${result.content[0].text}\n`);
    }
    return result.isError ? 1 : 0;
  } finally {
    await runtime.close();
  }
}
