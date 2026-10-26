import fs from "node:fs";
import { ALL_TOOL_NAMES } from "./mcp/server.js";

export interface CliOptions {
  showVersion: boolean;
  showHelp: boolean;
  doctor: boolean;
  port?: number;
  host?: string;
  screenshotDir?: string;
  connectUrl?: string;
  token?: string;
  enabledTools?: string[];
  disabledTools?: string[];
  redact: boolean;
  standalone: boolean;
  /** Print every captured entry as it arrives. */
  verbose: boolean;
  /** Loopback/private origins audits may target or load without an open tab. */
  auditAllowedOrigins?: string[];
  /** Let audits reach any loopback/private address but the audits' own ports (not recommended). */
  auditAllowPrivateNetwork: boolean;
  /** State-changing local API calls, without a panel confirmation. */
  allowActions: boolean;
  /** Only this extension may pair. Bare id or full origin. */
  extensionId?: string;
  /**
   * Script evaluation. Argv only — not read from the environment — and off
   * unless this flag is present.
   */
  allowEval: boolean;
  /**
   * Click, type, key presses, navigation, and soft input. Argv only, off
   * unless this flag is present.
   */
  allowInput: boolean;
  /** http(s) origins where input and navigation are allowed besides local addresses. */
  allowInputOrigins?: string[];
  /** http(s) origins that are never acted on. Empty unless set. */
  excludeOrigins?: string[];
}

export function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Parses argv and environment. Metadata flags are recognised here so that
 * `--version` and `--help` answer immediately, without starting a server.
 */
export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    showVersion: false,
    showHelp: false,
    doctor: false,
    redact: env["BROWSER_TOOLS_REDACT"] !== "false",
    standalone: false,
    verbose: env["BROWSER_TOOLS_VERBOSE"] === "true" || env["BROWSER_TOOLS_VERBOSE"] === "1",
    auditAllowPrivateNetwork:
      env["BROWSER_TOOLS_AUDIT_ALLOW_PRIVATE_NETWORK"] === "true" ||
      env["BROWSER_TOOLS_AUDIT_ALLOW_PRIVATE_NETWORK"] === "1",
    allowActions:
      env["BROWSER_TOOLS_ALLOW_ACTIONS"] === "true" || env["BROWSER_TOOLS_ALLOW_ACTIONS"] === "1",
    ...(env["BROWSER_TOOLS_EXTENSION_ID"]
      ? { extensionId: env["BROWSER_TOOLS_EXTENSION_ID"] }
      : {}),
    // Capability flags are argv only. They are intentionally not read from the
    // environment, so an inherited variable cannot turn them on.
    allowEval: false,
    allowInput: false,
    ...(splitList(env["BROWSER_TOOLS_AUDIT_ALLOW_ORIGINS"])
      ? { auditAllowedOrigins: splitList(env["BROWSER_TOOLS_AUDIT_ALLOW_ORIGINS"]) }
      : {}),
    ...(numberOrUndefined(env["BROWSER_TOOLS_PORT"]) !== undefined
      ? { port: numberOrUndefined(env["BROWSER_TOOLS_PORT"]) }
      : {}),
    ...(env["BROWSER_TOOLS_HOST"] ? { host: env["BROWSER_TOOLS_HOST"] } : {}),
    ...(env["BROWSER_TOOLS_SCREENSHOT_DIR"]
      ? { screenshotDir: env["BROWSER_TOOLS_SCREENSHOT_DIR"] }
      : {}),
    ...(env["BROWSER_TOOLS_TOKEN"] ? { token: env["BROWSER_TOOLS_TOKEN"] } : {}),
    ...(splitList(env["BROWSER_TOOLS_TOOLS"])
      ? { enabledTools: splitList(env["BROWSER_TOOLS_TOOLS"]) }
      : {}),
    ...(splitList(env["BROWSER_TOOLS_EXCLUDE_TOOLS"])
      ? { disabledTools: splitList(env["BROWSER_TOOLS_EXCLUDE_TOOLS"]) }
      : {}),
  };

  // Both spellings of the flag, and the variable, add to the same list.
  const addAuditOrigins = (value: string | undefined) => {
    options.auditAllowedOrigins = [...(options.auditAllowedOrigins ?? []), ...(splitList(value) ?? [])];
  };
  const addInputOrigins = (value: string | undefined) => {
    options.allowInputOrigins = [...(options.allowInputOrigins ?? []), ...(splitList(value) ?? [])];
  };
  const addExcludeOrigins = (value: string | undefined) => {
    options.excludeOrigins = [...(options.excludeOrigins ?? []), ...(splitList(value) ?? [])];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];

    switch (arg) {
      case "--version":
      case "-v":
        options.showVersion = true;
        break;
      case "--help":
      case "-h":
      case "help":
        options.showHelp = true;
        break;
      case "--doctor":
        options.doctor = true;
        break;
      case "--standalone":
        options.standalone = true;
        break;
      case "--no-redact":
        options.redact = false;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--audit-allow-origin":
        addAuditOrigins(next());
        break;
      case "--audit-allow-private-network":
        options.auditAllowPrivateNetwork = true;
        break;
      case "--allow-actions":
        options.allowActions = true;
        break;
      case "--extension-id":
        options.extensionId = next();
        break;
      case "--allow-eval":
        options.allowEval = true;
        break;
      case "--allow-input":
        options.allowInput = true;
        break;
      case "--allow-input-origins":
        addInputOrigins(next());
        break;
      case "--exclude-origins":
        addExcludeOrigins(next());
        break;
      case "--port":
        options.port = numberOrUndefined(next());
        break;
      case "--host":
        options.host = next();
        break;
      case "--screenshot-dir":
        options.screenshotDir = next();
        break;
      case "--connect":
        options.connectUrl = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--only":
        options.enabledTools = splitList(next());
        break;
      case "--exclude":
        options.disabledTools = splitList(next());
        break;
      default:
        if (arg.startsWith("--port=")) options.port = numberOrUndefined(arg.slice(7));
        else if (arg.startsWith("--host=")) options.host = arg.slice(7);
        else if (arg.startsWith("--only=")) options.enabledTools = splitList(arg.slice(7));
        else if (arg.startsWith("--exclude=")) options.disabledTools = splitList(arg.slice(10));
        else if (arg.startsWith("--connect=")) options.connectUrl = arg.slice(10);
        else if (arg.startsWith("--token=")) options.token = arg.slice(8);
        else if (arg.startsWith("--screenshot-dir=")) options.screenshotDir = arg.slice(17);
        else if (arg.startsWith("--audit-allow-origin=")) addAuditOrigins(arg.slice(21));
        else if (arg.startsWith("--extension-id=")) options.extensionId = arg.slice(15);
        else if (arg.startsWith("--allow-input-origins=")) addInputOrigins(arg.slice("--allow-input-origins=".length));
        else if (arg.startsWith("--exclude-origins=")) addExcludeOrigins(arg.slice("--exclude-origins=".length));
        break;
    }
  }

  return options;
}

export function helpText(): string {
  return `BrowserTools MCP — live browser telemetry for AI coding agents

Usage:
  browser-tools-mcp [options]

The MCP server embeds the browser connector, so this is the only process you
need to run. Point your MCP client at this command and install the Chrome
extension.

Options:
  -v, --version            Print the version and exit
  -h, --help               Print this help and exit
      --doctor             Check the local setup and exit
      --port <n>           Port for the connector the extension talks to (default 3025)
      --host <addr>        Loopback address to bind (default 127.0.0.1)
      --screenshot-dir <p> Where screenshots are written
      --only <a,b>         Expose only these tools
      --exclude <a,b>      Hide these tools (also on the local API)
      --allow-actions      Let the local API reload, capture, wipe and change settings
      --extension-id <id>  Only this extension may connect
      --connect <url>      Attach to a connector already running at this URL
      --token <t>          Auth token to use with --connect
      --verbose            Print each captured console and network entry as it arrives
      --no-redact          Do not scrub credentials from captured data (not recommended)
      --audit-allow-origin <o,o>
                           Loopback/private origins (e.g. http://localhost:3000) that audits
                           may target or load even when no tab is open on them
      --audit-allow-private-network
                           Let audits reach any loopback or private address, except the
                           audits' own ports (not recommended). Also needed behind a
                           fake-IP proxy (198.18.0.0/15 answers are refused otherwise)
      --allow-eval         Allow script evaluation. Off unless passed. No environment variable.
      --allow-input        Allow click, type, navigation, and soft input. Off unless passed.
                           No environment variable.
      --allow-input-origins <o,o>
                           http(s) origins where input and navigation are allowed besides
                           local addresses (for example https://example.com)
      --exclude-origins <o,o>
                           http(s) origins that are never acted on. Empty unless set.

Environment:
  BROWSER_TOOLS_PORT, BROWSER_TOOLS_HOST, BROWSER_TOOLS_SCREENSHOT_DIR,
  BROWSER_TOOLS_TOOLS, BROWSER_TOOLS_EXCLUDE_TOOLS, BROWSER_TOOLS_TOKEN,
  BROWSER_TOOLS_STATE_DIR, BROWSER_TOOLS_LOG_LEVEL, BROWSER_TOOLS_REDACT,
  BROWSER_TOOLS_VERBOSE, BROWSER_TOOLS_AUDIT_ALLOW_ORIGINS,
  BROWSER_TOOLS_AUDIT_ALLOW_PRIVATE_NETWORK, BROWSER_TOOLS_ALLOW_ACTIONS,
  BROWSER_TOOLS_EXTENSION_ID

Available tools:
  ${ALL_TOOL_NAMES.join(", ")}
`;
}
