import express, { type Express, type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "node:stream";

import {
  TelemetryStore,
  type ConsoleEntry,
  type ConsoleQuery,
  type NetworkEntry,
  type NetworkQuery,
  type QueryResult,
  type TabId,
} from "./store.js";
import { API_TOOL_NAMES, decideApiAccess, resolveEnabledTools } from "./api-policy.js";
import {
  WEBSOCKET_PROTOCOL,
  bearerToken,
  extensionOriginAllowed,
  isExtensionOrigin,
  isAllowedHostHeader,
  isLoopbackHost,
  localOnlyGuard,
  requireToken,
  websocketProtocolTokens,
} from "./security.js";
import { generateToken, tokensMatch } from "../util/session.js";
import { createLogger } from "../util/logger.js";
import {
  getDefaultScreenshotDir,
  resolveSafeScreenshotPath,
  screenshotFilename,
  UnsafePathError,
} from "../util/paths.js";
import {
  approximateBytes,
  extensionForMimeType,
  parseImageDataUrl,
  withExtension,
} from "../util/image.js";
import {
  AuditError,
  assertAuditableUrl,
  runLighthouseAudit,
  type AuditHooks,
  type AuditOptions,
} from "../lighthouse/runner.js";
import {
  isLocalName,
  namesThisMachine,
  originOf,
  resolveDestination,
  vouchKeyOf,
  vouchKeysOf,
} from "../lighthouse/destination.js";
import { isAuditCategory, type AuditCategory, type AuditReport } from "../lighthouse/types.js";
import {
  decideCapability,
  GateReason,
  INPUT_ACTIONS,
  isNoDevtoolsAction,
  normalizeOriginList,
  PANEL_ACTIONS,
  type CapabilityAction,
  type GatePolicy,
} from "../gates/capability.js";

export const SERVER_SIGNATURE = "mcp-browser-connector-24x7";
export const SERVER_VERSION = "2.0.0";

const log = createLogger("connector");

export class NoExtensionError extends Error {
  constructor() {
    super(
      "No browser extension is connected. Open Chrome DevTools (F12) on the page you want to inspect; " +
        "capture starts as soon as DevTools is open. Run `browser-tools-mcp --doctor` to check the setup."
    );
    this.name = "NoExtensionError";
  }
}

export class UnknownTabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTabError";
  }
}

export class ExtensionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRequestError";
  }
}

export class ExtensionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionTimeoutError";
  }
}

export interface ConnectorConfig {
  /** Loopback address to bind. Non-loopback requires allowNonLoopback. */
  host?: string;
  /** 0 picks an ephemeral port; otherwise the first free port from here. */
  port?: number;
  token?: string;
  screenshotDir?: string;
  redact?: boolean;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  maxBodySize?: string;
  /** Escape hatch, off by default, for users who knowingly expose the server. */
  allowNonLoopback?: boolean;
  /**
   * Print each captured entry as it arrives.
   *
   * Off by default: this is a debugging aid for confirming capture works, and
   * on a busy page it is a lot of output.
   */
  verbose?: boolean;
  /**
   * Extra origins (scheme://host:port) on loopback or a private network that
   * audits may target, and audited local pages may load, even when no
   * connected tab is on them.
   */
  auditAllowedOrigins?: string[];
  /**
   * Let audits reach any loopback or private address. Off by default: with it
   * on, anything that can call an audit tool can make the audit browser read
   * internal services. Link-local and metadata addresses stay blocked. Also
   * the only way to audit behind a fake-IP proxy, whose 198.18.0.0/15 answers
   * are refused otherwise.
   */
  auditAllowPrivateNetwork?: boolean;
  /** Injectable so audits can be exercised without launching a browser. */
  auditRunner?: (
    options: { url: string; category: AuditCategory; egress: AuditOptions["egress"] },
    hooks?: AuditHooks
  ) => Promise<AuditReport>;
  /** Injectable DNS for tests of the audit destination policy. */
  auditLookup?: (host: string) => Promise<string[]>;
  /**
   * When set, the local API serves only these tools. Same meaning as the MCP
   * `--only` flag. Unknown names are ignored.
   */
  enabledTools?: string[];
  /** Tools the local API will not serve. Applied after `enabledTools`. */
  disabledTools?: string[];
  /**
   * Lets the local API perform state-changing calls without a panel
   * confirmation. Off by default.
   */
  allowActions?: boolean;
  /**
   * When set, only this extension (bare id or full origin) may pair and
   * open the extension socket. Other extension origins are refused.
   */
  extensionId?: string;
  /** Script evaluation. Off unless the process was started with --allow-eval. */
  allowEval?: boolean;
  /** Click, type, navigation, and soft input. Off unless started with --allow-input. */
  allowInput?: boolean;
  /** http(s) origins where input and navigation are allowed besides local addresses. */
  allowInputOrigins?: string[];
  /** http(s) origins that are never acted on. Empty unless set. */
  excludeOrigins?: string[];
}

export interface TabView {
  tabId: TabId;
  url: string;
  /** True for the tab that tools act on when no tabId is given. */
  isCurrent: boolean;
  consoleCount: number;
  networkCount: number;
}

export interface ExportResult<T> {
  tabId: TabId | null;
  url: string;
  entries: T[];
}

export interface Artifact {
  mimeType: string;
  /** Text artifacts carry `text`; binary ones carry base64 `blob`. */
  text?: string;
  blob?: string;
}

/** A query result, plus which tab it describes. */
export interface TabScopedResult<T> extends QueryResult<T> {
  tabId: TabId | null;
  url: string;
  /** Connected tabs this result does NOT cover. */
  otherTabs: number;
}

export interface ScreenshotCapture {
  path: string;
  /** Data URL, carrying whichever format the browser settled on. */
  data: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** False when the browser could not get the image under the byte budget. */
  withinBudget: boolean;
  /** Which tab was captured, so a wrong-tab shot is obvious rather than silent. */
  tabId: TabId | null;
  url: string;
}

export interface Connector {
  app: Express;
  server: http.Server;
  store: TelemetryStore;
  port: number;
  host: string;
  token: string;
  screenshotDir: string;
  hasExtension(): boolean;
  /** Tabs with DevTools open right now. */
  listTabs(): TabView[];
  getCurrentTabId(): TabId | null;
  setCurrentTab(tabId: TabId): void;
  queryConsole(query: ConsoleQuery & { allTabs?: boolean }): TabScopedResult<ConsoleEntry>;
  queryNetwork(query: NetworkQuery & { allTabs?: boolean }): TabScopedResult<NetworkEntry>;
  getSelectedElement(options?: { tabId?: TabId }): unknown;
  /** Complete history, with no per-call budget applied. Backs the resources. */
  exportConsole(options?: { tabId?: TabId; allTabs?: boolean }): ExportResult<ConsoleEntry>;
  exportNetwork(options?: { tabId?: TabId; allTabs?: boolean }): ExportResult<NetworkEntry>;
  readArtifact(kind: "screenshot" | "audit", name: string): Promise<Artifact>;
  captureScreenshot(options?: { name?: string; tabId?: TabId }): Promise<ScreenshotCapture>;
  refreshTab(options?: { tabId?: TabId }): Promise<void>;
  readStorage(kinds: string[], options?: { tabId?: TabId }): Promise<Record<string, unknown>>;
  runAudit(
    category: AuditCategory,
    options?: { url?: string; tabId?: TabId }
  ): Promise<AuditReport>;
  /**
   * Decides a capability action. Does not perform it.
   * The live URL comes from the extension worker's tab read during this call,
   * not from the URL the connector last stored for the tab.
   */
  checkCapability(
    action: CapabilityAction,
    options?: { tabId?: TabId; destinationUrl?: string; hideBanner?: boolean }
  ): Promise<CapabilityCheck>;
  close(): Promise<void>;
}

export interface CapabilityCheck {
  allowed: boolean;
  action: string;
  reason: string;
  liveUrl: string | null;
}

interface ExtensionConnection {
  ws: WebSocket;
  id: string;
  awaitingPong: boolean;
  missedPings: number;
  lastSeen: number;
  tabId: number | string | null;
  /** The page an extension that never named its tab last reported. */
  pageUrl?: string;
  /** Set by the DevTools panel. Dies with the socket. */
  actionsConfirmed: boolean;
  /** Worker sockets answer capability probes. They are not DevTools tabs. */
  role: "devtools" | "worker";
  /** True when the browser set an extension Origin on the upgrade. */
  fromExtension: boolean;
  /** Popup report that arrived before hello named this socket as the worker. */
  pendingPopup?: boolean;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Only the connection the request was sent to may answer it. */
  connectionId: string;
}

/** A browser tab that has had DevTools open during this connector's lifetime. */
interface TabRecord {
  tabId: TabId;
  connectionId: string | null;
  url: string;
  lastActivityAt: number;
}

export async function createConnector(config: ConnectorConfig = {}): Promise<Connector> {
  const host = config.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !config.allowNonLoopback) {
    throw new Error(
      `Refusing to bind ${host}: the connector accepts loopback addresses only. ` +
        `Everything it exposes — console logs, network bodies, screenshots — would ` +
        `otherwise be reachable from the local network. Set allowNonLoopback to override.`
    );
  }

  const token = config.token ?? generateToken();
  const toolFilter = resolveEnabledTools(API_TOOL_NAMES, config.enabledTools, config.disabledTools);
  const extensionId = config.extensionId?.trim() || undefined;
  const allowActions = config.allowActions === true;
  if (toolFilter.unknown.length > 0) {
    log.warn(`Ignoring unknown tool name(s) in filter: ${toolFilter.unknown.join(", ")}`);
  }
  const screenshotDir = path.resolve(config.screenshotDir ?? getDefaultScreenshotDir());
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 15_000;
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;

  const store = new TelemetryStore({ redact: config.redact !== false });
  const verbose = config.verbose === true;

  const inputOriginList = normalizeOriginList(config.allowInputOrigins);
  const excludeOriginList = normalizeOriginList(config.excludeOrigins);
  for (const rejected of [...inputOriginList.rejected, ...excludeOriginList.rejected]) {
    log.warn(`Ignoring capability origin ${JSON.stringify(rejected)}: not an http(s) origin`);
  }
  const capabilityPolicy: GatePolicy = {
    allowEval: config.allowEval === true,
    allowInput: config.allowInput === true,
    inputOrigins: inputOriginList.origins,
    excludeOrigins: excludeOriginList.origins,
  };
  const excludeListInvalid = excludeOriginList.rejected.length > 0;
  let popupEnabled = false;
  let panelEnabled = false;

  /**
   * Reports a captured entry to the terminal.
   *
   * Goes through the logger, so it lands on stderr — the MCP server shares this
   * process with the JSON-RPC stream on stdout, and a stray write there ends the
   * session. Values are already redacted by the time they arrive.
   */
  function reportCapture(kind: "console" | "network", entry: unknown, tabId: TabId | null): void {
    if (!verbose || !entry) return;
    const where = tabId === null ? "" : ` tab ${tabId}`;

    if (kind === "console") {
      const e = entry as ConsoleEntry;
      log.info(`· console ${e.level}${where} ${clip(e.message)}`);
      return;
    }
    const e = entry as NetworkEntry;
    const took = e.durationMs ? ` (${e.durationMs}ms)` : "";
    log.info(`· network ${e.status || "---"} ${e.method}${where} ${clip(e.url)}${took}`);
  }

  const connections = new Map<string, ExtensionConnection>();
  const pending = new Map<string, PendingRequest>();

  /** Tabs currently connected, keyed by String(tabId). */
  const tabs = new Map<string, TabRecord>();
  /**
   * Every tabId bound during this connector's life, including tabs that have
   * since disconnected. This is what distinguishes a user deliberately opening
   * DevTools on a new tab from a throttled tab's socket coming back — both look
   * identical on the wire.
   */
  const seenTabIds = new Set<string>();
  let currentTabId: TabId | null = null;

  // ------------------------------------------------------------- http app

  const app = express();
  app.disable("x-powered-by");
  // Deliberately no cors() — the connector is same-machine only, and a
  // wildcard CORS policy is what let any visited page read captured telemetry.
  app.use(localOnlyGuard());
  app.use(express.json({ limit: config.maxBodySize ?? "10mb" }));

  app.get("/.identity", (_req: Request, res: Response) => {
    res.json({
      name: "BrowserTools Connector",
      version: SERVER_VERSION,
      signature: SERVER_SIGNATURE,
      port: actualPort,
      extensionConnected: telemetryConnected(),
    });
  });

  // The extension cannot set an Authorization header on a WebSocket, so it
  // collects the token here and offers it as a subprotocol. A page origin is
  // already refused by localOnlyGuard; a non-browser client has no extension
  // origin and is refused here too. The token is not on /.identity.
  app.post("/.pair", (req: Request, res: Response) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!extensionOriginAllowed(origin, extensionId)) {
      res.status(403).json({
        error: "Extension pairing is not accepted from this origin",
        code: "FORBIDDEN_ORIGIN",
      });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ token });
  });

  const api = express.Router();
  api.use(requireToken(token));
  api.use((req, res, next) => {
    const decision = decideApiAccess({
      method: req.method,
      path: req.path,
      query: req.query as Record<string, unknown>,
      enabled: toolFilter.enabled,
      actionsAllowed: allowActions || actionsConfirmed(),
    });
    if (!decision.ok) {
      res.status(403).json({ error: decision.error, code: decision.code });
      return;
    }
    next();
  });

  api.get("/settings", (_req, res) => {
    res.json({ settings: store.settings });
  });

  api.post("/settings", (req, res) => {
    const settings = store.updateSettings(req.body);
    broadcast({ type: "settings", settings });
    res.json({ settings });
  });

  api.get("/export/:kind", (req: Request, res: Response) => {
    try {
      const kind = String(req.params["kind"] ?? "");
      const scope = parseTabScope(req.query);
      if (kind === "console") return void res.json(exportConsole(scope));
      if (kind === "network") return void res.json(exportNetwork(scope));
      res.status(400).json({ error: `Unknown export: ${kind}`, code: "BAD_EXPORT" });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.get("/artifact/:kind/:name", async (req: Request, res: Response) => {
    try {
      const kind = String(req.params["kind"] ?? "");
      if (kind !== "screenshot" && kind !== "audit") {
        return void res.status(400).json({ error: `Unknown artifact: ${kind}` });
      }
      res.json(await readArtifact(kind, String(req.params["name"] ?? "")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return void res.status(404).json({ error: "No such artifact", code: "NO_ARTIFACT" });
      }
      respondWithError(res, error);
    }
  });

  api.get("/tabs", (_req, res) => {
    res.json({ tabs: listTabs(), currentTabId, connectedTabs: tabs.size });
  });

  api.post("/tabs/select", (req: Request, res: Response) => {
    try {
      setCurrentTab(req.body?.tabId);
      res.json({ currentTabId });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.get("/console", (req: Request, res: Response) => {
    try {
      res.json(
        queryConsole({
          errorsOnly: parseBool(req.query["errorsOnly"]) ?? false,
          keywords: parseList(req.query["keywords"]),
          ...parseTabScope(req.query),
          limit: parseCount(req.query["limit"]),
          offset: parseCount(req.query["offset"]),
        })
      );
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.get("/network", (req: Request, res: Response) => {
    try {
      res.json(
        queryNetwork({
          errorsOnly: parseBool(req.query["errorsOnly"]) ?? false,
          urlKeywords: parseList(req.query["urlKeywords"]),
          bodyKeywords: parseList(req.query["bodyKeywords"]),
          ...parseTabScope(req.query),
          limit: parseCount(req.query["limit"]),
          offset: parseCount(req.query["offset"]),
        })
      );
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.get("/selected-element", (req: Request, res: Response) => {
    try {
      const scope = parseTabScope(req.query);
      res.json({
        element: getSelectedElement(scope.tabId !== undefined ? { tabId: scope.tabId } : {}),
      });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.get("/page", (_req, res) => {
    const current = currentTabId !== null ? tabs.get(String(currentTabId)) : undefined;
    const page = store.getCurrentPage();
    res.json({
      url: current?.url || page.url,
      tabId: currentTabId ?? page.tabId,
      extensionConnected: telemetryConnected(),
      connectedTabs: tabs.size,
    });
  });

  api.get("/status", (_req, res) => {
    res.json({
      version: SERVER_VERSION,
      extensionConnected: telemetryConnected(),
      connections: connections.size,
      tabs: tabs.size,
      currentTabId,
      screenshotDir,
      settings: store.settings,
      counts: {
        console: store.queryConsole({}).total,
        network: store.queryNetwork({}).total,
      },
    });
  });

  api.post("/wipe", (req, res) => {
    store.wipe(req.body?.tabId);
    res.json({ ok: true });
  });

  api.post("/screenshot", async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : undefined;
      const tabId = req.body?.tabId;
      const result = await captureScreenshot({
        ...(name ? { name } : {}),
        ...(tabId !== undefined ? { tabId } : {}),
      });
      res.json(result);
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/refresh", async (req: Request, res: Response) => {
    try {
      await refreshTab(req.body?.tabId !== undefined ? { tabId: req.body.tabId } : {});
      res.json({ ok: true });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/storage", async (req: Request, res: Response) => {
    try {
      const kinds = parseList(req.body?.kinds) ?? ["localStorage", "sessionStorage"];
      const storage = await readStorage(
        kinds,
        req.body?.tabId !== undefined ? { tabId: req.body.tabId } : {}
      );
      res.json({ storage });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/audit/:category", async (req: Request, res: Response) => {
    const category = String(req.params["category"] ?? "");
    if (!isAuditCategory(category)) {
      res.status(400).json({ error: `Unknown audit category: ${category}`, code: "BAD_CATEGORY" });
      return;
    }
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : undefined;
      const tabId = req.body?.tabId;
      res.json(
        await runAudit(category, {
          ...(url ? { url } : {}),
          ...(typeof tabId === "number" || typeof tabId === "string" ? { tabId } : {}),
        })
      );
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.use("/api", api);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode ?? 500);
    if (status === 413) {
      res.status(413).json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    log.error("Unhandled request error:", err);
    res.status(Number.isFinite(status) ? status : 500).json({
      error: err?.message ?? "Internal error",
    });
  });

  // ---------------------------------------------------------- http server

  const server = http.createServer(app);
  server.on("error", (error) => log.error("HTTP server error:", error));

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false),
  });
  wss.on("error", (error) => log.error("WebSocket server error:", error));

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname !== "/extension-ws") {
      return rejectUpgrade(socket, 404, "Not found");
    }

    const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
    if (!isAllowedHostHeader(hostHeader)) {
      return rejectUpgrade(socket, 403, "Forbidden host");
    }

    const originHeader = req.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : undefined;
    if (Array.isArray(originHeader) || (origin && !extensionOriginAllowed(origin, extensionId))) {
      log.warn("Rejected websocket upgrade from a non-extension origin");
      return rejectUpgrade(socket, 403, "Forbidden origin");
    }

    // The token used to travel in the query string, which is the URL access
    // logs keep. It is accepted from the Authorization header (non-browser
    // clients) or a websocket subprotocol (the extension, which cannot set
    // headers). An extension origin no longer skips the check: forging Origin
    // was enough to be treated as the extension.
    if (url.searchParams.has("token")) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const candidates = [bearerToken(authorization), ...websocketProtocolTokens(req.headers["sec-websocket-protocol"])];
    if (!candidates.some((presented) => presented && tokensMatch(presented, token))) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const id = crypto.randomUUID();
    const originHeader = req.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    const connection: ExtensionConnection = {
      ws,
      id,
      awaitingPong: false,
      missedPings: 0,
      lastSeen: Date.now(),
      tabId: null,
      actionsConfirmed: false,
      role: "devtools",
      fromExtension: isExtensionOrigin(origin),
    };
    connections.set(id, connection);
    log.info(`Extension connected (${connections.size} active)`);

    // Without this the process used to die on any socket-level error.
    ws.on("error", (error) => {
      log.warn("Extension socket error:", error);
      dropConnection(id);
    });

    ws.on("close", () => dropConnection(id));

    ws.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        log.warn("Discarded unparseable websocket frame");
        return;
      }
      try {
        handleExtensionMessage(connection, message);
      } catch (error) {
        log.warn("Error handling extension message:", error);
      }
    });

    send(ws, { type: "welcome", settings: store.settings, serverVersion: SERVER_VERSION });
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.awaitingPong) {
        connection.missedPings += 1;
        if (connection.missedPings >= 2) {
          log.warn("Extension stopped responding to pings; dropping it");
          try {
            connection.ws.terminate();
          } catch {
            /* already gone */
          }
          dropConnection(connection.id);
          continue;
        }
      }
      connection.awaitingPong = true;
      send(connection.ws, { type: "ping", id: crypto.randomUUID() });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  // -------------------------------------------------------------- helpers

  function actionsConfirmed(): boolean {
    for (const connection of connections.values()) {
      if (connection.actionsConfirmed) return true;
    }
    return false;
  }

  function dropConnection(id: string): void {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);

    // Fail anything waiting on this socket now, rather than letting the caller
    // sit through the full request timeout for a window that is already gone.
    for (const [requestId, entry] of [...pending.entries()]) {
      if (entry.connectionId !== id) continue;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(
        new ExtensionRequestError("The DevTools window handling this request was closed.")
      );
    }

    if (connection.tabId !== null) dropTab(connection.tabId, id);
    if (connection.role === "worker") {
      const anotherWorker = [...connections.values()].some(
        (candidate) => candidate.role === "worker" && candidate.fromExtension
      );
      if (!anotherWorker) popupEnabled = false;
    } else if (
      ![...connections.values()].some((candidate) => candidate.role !== "worker" && candidate.fromExtension)
    ) {
      panelEnabled = false;
    }
    log.info(`Extension disconnected (${connections.size} active)`);
  }

  // ------------------------------------------------------------------ tabs

  /**
   * Attaches a connection to a tab.
   *
   * A tab becomes current only the first time it is ever seen, which is the
   * user deliberately opening DevTools on it. A tab coming back — its socket
   * dropped by the heartbeat while throttled in the background, then
   * reconnecting — is indistinguishable on the wire, so `seenTabIds` is what
   * tells them apart. Without it, a background tab silently steals targeting
   * from the tab the user is looking at.
   */
  function bindTab(connection: ExtensionConnection, tabId: TabId): void {
    const key = String(tabId);
    connection.tabId = tabId;

    const existing = tabs.get(key);
    if (existing) {
      // A new socket for a known tab (the old one went quiet and the
      // extension reconnected before the heartbeat dropped it) has not said
      // where the tab is now. Whatever the old socket reported is stale: the
      // tab may have moved to a chrome:// or error page meanwhile, which
      // reports nothing on reconnect, and must not keep vouching for the
      // page it left (see `openOrigins`). The new socket reports its page
      // right after hello.
      if (existing.connectionId !== connection.id) existing.url = "";
      existing.connectionId = connection.id;
      existing.lastActivityAt = Date.now();
    } else {
      tabs.set(key, {
        tabId,
        connectionId: connection.id,
        url: "",
        lastActivityAt: Date.now(),
      });
    }

    const firstSight = !seenTabIds.has(key);
    seenTabIds.add(key);

    if (firstSight || currentTabId === null) {
      currentTabId = tabId;
      log.info(`Current tab is now ${key}`);
    }
  }

  function dropTab(tabId: TabId, connectionId: string): void {
    const key = String(tabId);
    const record = tabs.get(key);
    // A newer socket may already have rebound this tab; leave it alone.
    if (!record || record.connectionId !== connectionId) return;
    tabs.delete(key);

    if (String(currentTabId) === key) {
      const next = [...tabs.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
      currentTabId = next?.tabId ?? null;
    }

    // An empty registry means the browsing session ended. Chrome restarts tab
    // numbering, so without forgetting, a genuinely new tab could be mistaken
    // for one that is returning and would never become current.
    if (tabs.size === 0) seenTabIds.clear();
  }

  function listTabs(): TabView[] {
    return [...tabs.values()].map((record) => ({
      tabId: record.tabId,
      url: record.url,
      isCurrent: String(record.tabId) === String(currentTabId),
      consoleCount: store.queryConsole({ tabId: record.tabId }).total,
      networkCount: store.queryNetwork({ tabId: record.tabId }).total,
    }));
  }

  function tabUrl(tabId: TabId | null): string {
    if (tabId === null) return store.getCurrentPage().url;
    return tabs.get(String(tabId))?.url ?? "";
  }

  /** Scopes a query to one tab, defaulting to the current one. */
  function scope(allTabs: boolean | undefined, requested: TabId | undefined) {
    const tabId = allTabs ? null : resolveTabId(requested);
    return {
      tabId,
      url: tabUrl(tabId),
      otherTabs: tabId === null ? 0 : Math.max(0, tabs.size - 1),
    };
  }

  function queryConsole(
    query: ConsoleQuery & { allTabs?: boolean }
  ): TabScopedResult<ConsoleEntry> {
    const { allTabs, tabId: requested, ...rest } = query;
    const scoped = scope(allTabs, requested);
    const result = store.queryConsole(
      scoped.tabId === null ? rest : { ...rest, tabId: scoped.tabId }
    );
    return { ...result, ...scoped };
  }

  function queryNetwork(
    query: NetworkQuery & { allTabs?: boolean }
  ): TabScopedResult<NetworkEntry> {
    const { allTabs, tabId: requested, ...rest } = query;
    const scoped = scope(allTabs, requested);
    const result = store.queryNetwork(
      scoped.tabId === null ? rest : { ...rest, tabId: scoped.tabId }
    );
    return { ...result, ...scoped };
  }

  function exportConsole(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): ExportResult<ConsoleEntry> {
    const scoped = scope(options.allTabs, options.tabId);
    return {
      tabId: scoped.tabId,
      url: scoped.url,
      entries: store.allConsole(scoped.tabId ?? undefined),
    };
  }

  function exportNetwork(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): ExportResult<NetworkEntry> {
    const scoped = scope(options.allTabs, options.tabId);
    return {
      tabId: scoped.tabId,
      url: scoped.url,
      entries: store.allNetwork(scoped.tabId ?? undefined),
    };
  }

  const auditDir = path.join(screenshotDir, "audits");
  /** Raw Lighthouse results are megabytes each, so only recent ones are kept. */
  const MAX_STORED_AUDIT_REPORTS = 20;

  function pruneAuditReports(): void {
    try {
      const files = fs
        .readdirSync(auditDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({
          name,
          modified: fs.statSync(path.join(auditDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.modified - a.modified);

      for (const stale of files.slice(MAX_STORED_AUDIT_REPORTS)) {
        fs.rmSync(path.join(auditDir, stale.name), { force: true });
      }
    } catch (error) {
      log.warn("Could not prune stored audit reports:", error);
    }
  }

  /**
   * Reads a stored artifact by name.
   *
   * Names are resolved inside a fixed directory with the same validation used
   * for screenshot writes, so a resource uri cannot be turned into an arbitrary
   * file read.
   */
  async function readArtifact(kind: "screenshot" | "audit", name: string): Promise<Artifact> {
    const base = kind === "screenshot" ? screenshotDir : auditDir;
    const resolved = resolveSafeScreenshotPath(base, name);
    const bytes = await fs.promises.readFile(resolved);

    if (kind === "audit") {
      return { mimeType: "application/json", text: bytes.toString("utf8") };
    }
    const mimeType = resolved.endsWith(".jpg") ? "image/jpeg" : "image/png";
    return { mimeType, blob: bytes.toString("base64") };
  }

  function getSelectedElement(options: { tabId?: TabId } = {}): unknown {
    const tabId = resolveTabId(options.tabId);
    return tabId === null ? store.getSelectedElement() : store.getSelectedElement(tabId);
  }

  function describeTabs(): string {
    const live = [...tabs.values()];
    if (live.length === 0) return "No tabs are connected.";
    return `Connected tabs: ${live.map((t) => `${t.tabId} (${t.url || "unknown url"})`).join(", ")}.`;
  }

  function setCurrentTab(tabId: TabId): void {
    const key = String(tabId);
    if (!tabs.has(key)) {
      throw new UnknownTabError(`Unknown tab ${tabId}. ${describeTabs()}`);
    }
    currentTabId = tabs.get(key)!.tabId;
  }

  /** The tab a call refers to: the one named, else the current one. */
  function resolveTabId(requested?: TabId): TabId | null {
    if (requested === undefined || requested === null) return currentTabId;
    const key = String(requested);
    if (!tabs.has(key)) {
      throw new UnknownTabError(
        `Unknown tab ${requested}. ${describeTabs()} Call listBrowserTabs to see what is live.`
      );
    }
    return tabs.get(key)!.tabId;
  }

  /** The live socket for a tab, or an error explaining which tabs exist. */
  function connectionForTab(requested?: TabId): ExtensionConnection {
    const tabId = resolveTabId(requested);

    if (tabId === null) {
      // No tab identity at all — either the extension has connected but not yet
      // announced itself, or it predates tab reporting. There is no tab to pick
      // wrongly here, so use whatever socket is open. Once any tab is known this
      // path is never taken, and targeting is strict.
      const fallback = [...connections.values()]
        .filter((c) => c.role !== "worker" && c.ws.readyState === WebSocket.OPEN)
        .sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (!fallback) throw new NoExtensionError();
      return fallback;
    }

    const record = tabs.get(String(tabId));
    const connection = record?.connectionId ? connections.get(record.connectionId) : undefined;
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new NoExtensionError();
    }
    return connection;
  }

  function handleExtensionMessage(
    connection: ExtensionConnection,
    message: Record<string, unknown>
  ): void {
    connection.lastSeen = Date.now();
    const type = typeof message["type"] === "string" ? (message["type"] as string) : "";

    if (
      connection.role === "worker" &&
      (type === "console" ||
        type === "network" ||
        type === "selected-element" ||
        type === "page" ||
        type === "settings")
    ) {
      return;
    }

    switch (type) {
      case "hello": {
        if (message["role"] === "worker" && connection.fromExtension) {
          connection.role = "worker";
          connection.tabId = null;
          if (connection.pendingPopup !== undefined) popupEnabled = connection.pendingPopup;
          break;
        }
        connection.role = "devtools";
        const tabId = message["tabId"];
        if (typeof tabId === "number" || typeof tabId === "string") bindTab(connection, tabId);
        break;
      }
      case "actions-confirmed":
        // The panel's confirmation. It is not a capture setting, and it does
        // not outlive this socket — closing DevTools withdraws it.
        connection.actionsConfirmed = message["confirmed"] === true;
        break;
      case "capability-state": {
        if (!connection.fromExtension) break;
        if (typeof message["popupEnabled"] === "boolean") {
          connection.pendingPopup = message["popupEnabled"];
          if (connection.role === "worker") popupEnabled = message["popupEnabled"];
        }
        if (connection.role !== "worker" && typeof message["panelEnabled"] === "boolean") {
          panelEnabled = message["panelEnabled"];
        }
        break;
      }
      case "pong":
        connection.awaitingPong = false;
        connection.missedPings = 0;
        break;
      // Attribution always comes from the connection, never the message body,
      // so one page cannot file its output against another tab.
      case "console":
        for (const entry of asEntries(message)) {
          reportCapture("console", store.addConsole(entry, connection.tabId), connection.tabId);
        }
        break;
      case "network":
        for (const entry of asEntries(message)) {
          reportCapture("network", store.addNetwork(entry, connection.tabId), connection.tabId);
        }
        break;
      case "selected-element":
        store.setSelectedElement(message["element"], connection.tabId);
        break;
      case "page": {
        const url = typeof message["url"] === "string" ? (message["url"] as string) : "";
        const record = connection.tabId !== null ? tabs.get(String(connection.tabId)) : undefined;
        // A report without a url replaces the old page too, rather than
        // leaving it vouched for (see `openOrigins`) after the tab has left.
        if (record) {
          record.url = url;
          record.lastActivityAt = Date.now();
        }
        // Navigating does not make a tab current — a background tab on a timer
        // would otherwise hijack every subsequent call.
        if (record && String(connection.tabId) === String(currentTabId)) {
          store.setCurrentPage({ url, tabId: connection.tabId });
        } else if (!record) {
          store.setCurrentPage({ url, tabId: message["tabId"] });
          if (connection.tabId === null) connection.pageUrl = url || undefined;
        }
        break;
      }
      case "settings":
        store.updateSettings(message["settings"]);
        break;
      case "screenshot-result":
      case "refresh-result":
      case "storage-result":
      case "capability-probe-result":
        resolvePending(connection, message);
        break;
      default:
        log.debug(`Ignoring unknown message type: ${type || "(none)"}`);
    }
  }

  function resolvePending(
    connection: ExtensionConnection,
    message: Record<string, unknown>
  ): void {
    const requestId = typeof message["requestId"] === "string" ? message["requestId"] : "";
    const entry = pending.get(requestId);
    if (!entry) {
      log.debug("Received a response for an unknown or expired request");
      return;
    }
    // With several tabs connected, any of them could otherwise answer another
    // tab's request and be believed.
    if (entry.connectionId !== connection.id) {
      log.warn("Discarded a response that came from a different tab than was asked");
      return;
    }
    pending.delete(requestId);
    clearTimeout(entry.timer);

    if (message["ok"] === false) {
      const reason = typeof message["error"] === "string" ? message["error"] : "Extension reported a failure";
      entry.reject(new ExtensionRequestError(reason));
      return;
    }
    entry.resolve(message);
  }

  /** Sends a request to one tab's DevTools page and awaits its answer. */
  function requestFromExtension(
    connection: ExtensionConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new ExtensionTimeoutError(`The extension did not answer ${type} in time`));
      }, requestTimeoutMs);
      timer.unref?.();

      pending.set(requestId, { resolve, reject, timer, connectionId: connection.id });
      send(connection.ws, { type, requestId, ...payload });
    });
  }

  async function captureScreenshot(
    options: { name?: string; tabId?: TabId } = {}
  ): Promise<ScreenshotCapture> {
    // Validate the destination before involving the browser at all, so a bad
    // name is rejected as a bad name whether or not a tab is connected.
    const requestedName = options.name ?? screenshotFilename();
    resolveSafeScreenshotPath(screenshotDir, requestedName);

    const connection = connectionForTab(options.tabId);

    const maxBytes = store.settings.screenshotMaxBytes;
    const response = await requestFromExtension(connection, "capture-screenshot", {
      name: requestedName,
      maxBytes,
    });

    const parsed = parseImageDataUrl(
      typeof response["data"] === "string" ? response["data"] : ""
    );
    if (!parsed) {
      throw new ExtensionRequestError(
        "The extension returned an empty or unsupported screenshot payload"
      );
    }

    // The browser may have fallen back to JPEG to meet the budget, so the file
    // is named for the bytes actually being written rather than what was asked for.
    const finalName = withExtension(requestedName, extensionForMimeType(parsed.mimeType));
    const destination = resolveSafeScreenshotPath(screenshotDir, finalName);
    const bytes = approximateBytes(parsed.base64);

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, Buffer.from(parsed.base64, "base64"));

    if (bytes > maxBytes) {
      log.warn(
        `Screenshot is ${bytes} bytes, over the ${maxBytes} budget; it was saved to ${destination} but will not be inlined.`
      );
    }

    return {
      path: destination,
      data: `data:${parsed.mimeType};base64,${parsed.base64}`,
      name: finalName,
      mimeType: parsed.mimeType,
      bytes,
      withinBudget: bytes <= maxBytes,
      tabId: connection.tabId,
      url: connection.tabId !== null ? tabUrl(connection.tabId) : store.getCurrentPage().url,
    };
  }

  async function refreshTab(options: { tabId?: TabId } = {}): Promise<void> {
    await requestFromExtension(connectionForTab(options.tabId), "refresh-tab");
  }

  async function readStorage(
    kinds: string[],
    options: { tabId?: TabId } = {}
  ): Promise<Record<string, unknown>> {
    const response = await requestFromExtension(connectionForTab(options.tabId), "get-storage", {
      kinds,
    });
    const storage = response["storage"];
    return storage && typeof storage === "object" ? (storage as Record<string, unknown>) : {};
  }

  /**
   * Audits whatever page the browser is on, unless a url is given.
   *
   * The old implementation polled an internal variable for 25 seconds waiting
   * for a url that nothing ever set; if the page is unknown, say so at once.
   */
  async function runAudit(
    category: AuditCategory,
    options: { url?: string; tabId?: TabId } = {}
  ): Promise<AuditReport> {
    // The named tab's page, else the current tab's: that tab's own, never
    // whatever page the store saw last, which follows page reports rather
    // than tab selection and may be another tab's. The store's page is only
    // for an extension that never names its tab.
    const tabId = resolveTabId(options.tabId);
    let url = options.url;
    if (!url && tabId !== null) {
      url = tabs.get(String(tabId))?.url;
      if (!url) {
        throw new AuditError(
          `Tab ${tabId} has not reported its page yet. Wait for it to load, or pass a url explicitly.`
        );
      }
    }
    url ||= store.getCurrentPage().url;
    if (!url) {
      throw new AuditError(
        "No page URL is known yet. Open the page in Chrome with DevTools open, or pass a url explicitly."
      );
    }
    const egress = await checkAuditTarget(url);
    const runner = config.auditRunner ?? runLighthouseAudit;

    // The condensed report is what an agent reads; the unabridged Lighthouse
    // result is kept on disk and offered as a resource for when it is needed.
    let reportId: string | undefined;
    const hooks: AuditHooks = {
      onRawResult: (lhr) => {
        try {
          fs.mkdirSync(auditDir, { recursive: true });
          const name = `${category}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`;
          fs.writeFileSync(resolveSafeScreenshotPath(auditDir, name), JSON.stringify(lhr));
          reportId = name;
          pruneAuditReports();
        } catch (error) {
          log.warn("Could not store the full audit report:", error);
        }
      },
    };

    // The connector's own port is the audit's machinery too: its identity
    // route needs no token, and nothing a page loads has business there.
    const report = await runner(
      {
        url,
        category,
        egress: {
          ...egress,
          refusePorts: [actualPortHolder.value],
          ...(config.auditLookup ? { lookup: config.auditLookup } : {}),
        },
      },
      hooks
    );
    return reportId ? { ...report, reportId } : report;
  }

  /**
   * Origins from --audit-allow-origin, normalised once. "localhost:3000" is
   * accepted as http://localhost:3000 — written as a URL it would parse as a
   * "localhost:" scheme and be ignored without a word, which would read as the
   * flag not working. Anything else unparseable is reported, not dropped.
   */
  const configuredAuditOrigins = new Set<string>();
  for (const raw of config.auditAllowedOrigins ?? []) {
    const entry = raw.trim();
    if (!entry) continue;
    const origin = originOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`);
    if (origin) configuredAuditOrigins.add(origin);
    else log.warn(`Ignoring audit-allow-origin ${JSON.stringify(raw)}: not an http(s) origin`);
  }

  /** Origins of the pages open in a connected tab right now. */
  function openOrigins(): Set<string> {
    const origins = new Set<string>();
    for (const record of tabs.values()) {
      const origin = record.url ? originOf(record.url) : null;
      if (origin) origins.add(origin);
    }
    // An extension that never names its tab reports its page with no tab to
    // file it under, so that page is kept on the socket that reported it and
    // counts while the socket is open. The store's current page is not used:
    // nothing clears it, so it would keep vouching for a page long closed.
    for (const connection of connections.values()) {
      const origin = connection.tabId === null && connection.pageUrl ? originOf(connection.pageUrl) : null;
      if (origin) origins.add(origin);
    }
    return origins;
  }

  /**
   * Whether one of these origins vouches for the url: by the host and port
   * keys the egress proxy matches (`vouchKeysOf`), and the scheme. A tab on
   * localhost:3000 vouches for an audit of 127.0.0.1:3000 or [::1]:3000, as
   * it already lets the page load them; a tab on one address vouches for that
   * address alone.
   */
  function vouchesFor(origins: Set<string>, url: URL): boolean {
    const key = vouchKeyOf(url);
    return key !== null && [...origins].some((origin) => vouchKeysOf(origin).includes(key));
  }

  /** Whether a vouched origin is this machine's same port and scheme as the url, under another spelling. */
  function sameLocalPort(origin: string, url: URL): boolean {
    const candidate = originOf(origin);
    const target = originOf(url);
    if (!candidate || !target || candidate === target) return false;
    const a = new URL(candidate);
    const b = new URL(target);
    return a.protocol === b.protocol && a.port === b.port && namesThisMachine(a.hostname);
  }

  /**
   * Loopback and private origins an audit may load: the configured ones, and
   * the ones open in a connected tab under a local name. A tab on a public
   * name vouches for nothing private (see `isLocalName`).
   */
  function vouchedOrigins(): Set<string> {
    const origins = new Set<string>(configuredAuditOrigins);
    for (const origin of openOrigins()) {
      if (isLocalName(new URL(origin).hostname)) origins.add(origin);
    }
    return origins;
  }

  /**
   * Decides whether an audit may target this url, before any browser starts.
   *
   * Audits accept a url from the MCP client, and the client may be a model
   * acting on prompt-injected page content. Public sites are fine to audit.
   * Loopback and private-network pages are allowed only when they are already
   * open in a connected tab — the user went there, and the extension already
   * captures that page — or are explicitly allowlisted. Link-local and cloud
   * metadata addresses are never allowed.
   *
   * The answer also says what the page may load. A public page loads nothing
   * local. A local page loads the vouched origins and no other local ones, so
   * an open redirect or a framed page cannot carry the audit further inside.
   */
  async function checkAuditTarget(
    url: string
  ): Promise<{ allowPrivate: boolean; allowedOrigins: string[] }> {
    const parsed = assertAuditableUrl(url);
    const dest = await resolveDestination(parsed.hostname, config.auditLookup);
    if (dest.unresolved) {
      throw new AuditError(
        `Cannot audit ${parsed.hostname}: the name does not resolve. Check the url, or try again if ` +
          `the network was briefly down.`
      );
    }
    if (dest.class === "blocked") {
      throw new AuditError(
        `Refusing to audit ${parsed.hostname}: it resolves to a link-local, cloud metadata or reserved ` +
          `address.`
      );
    }
    if (config.auditAllowPrivateNetwork) return { allowPrivate: true, allowedOrigins: [] };
    if (dest.class === "public") return { allowPrivate: false, allowedOrigins: [] };
    // A fake-ip address stands for whatever the proxy behind it decides, so no
    // tab or allowlist entry can vouch for it (see `destination.ts`).
    if (dest.class === "fake-ip") {
      throw new AuditError(
        `Refusing to audit ${parsed.hostname}: it resolves to 198.18.0.0/15, the range a fake-IP proxy ` +
          `(Clash, sing-box, Surge in fake-ip mode) answers every name with, so where it really goes cannot ` +
          `be checked. Turn fake-ip mode off while auditing, or start the connector with ` +
          `--audit-allow-private-network.`
      );
    }

    const origin = originOf(parsed)!;
    const vouched = vouchedOrigins();
    if (vouchesFor(vouched, parsed)) {
      return { allowPrivate: false, allowedOrigins: [...new Set([...vouched, origin])] };
    }

    const where = dest.class === "loopback" ? "this machine" : "a private network";
    // The same port on this machine under another spelling is vouched for:
    // say why that does not count, rather than that nothing is open.
    if (dest.class === "loopback") {
      const isSibling = (candidate: string) => sameLocalPort(candidate, parsed);
      const open = [...openOrigins()].find(isSibling);
      const sibling = open ?? [...configuredAuditOrigins].find(isSibling);
      if (sibling) {
        throw new AuditError(
          `Refusing to audit ${origin}: ${sibling} is ${open ? "open in a connected tab" : "allowlisted"}, ` +
            `but a loopback address or *.localhost name vouches for itself alone, since a service bound to ` +
            `one may not be the one another reaches. Audit ${sibling} instead, or allow ${origin} with ` +
            `--audit-allow-origin.`
        );
      }
    }
    if (vouchesFor(openOrigins(), parsed)) {
      throw new AuditError(
        `Refusing to audit ${origin}: ${parsed.hostname} is a public DNS name that points at ${where}. ` +
          `An open tab only vouches for local names (IP addresses, localhost, .test, .local and the ` +
          `like), because whoever runs a public name can point it anywhere. If it is yours, allow it ` +
          `with --audit-allow-origin.`
      );
    }
    throw new AuditError(
      `Refusing to audit ${origin}: it is on ${where} and is not open in a connected browser tab. ` +
        `Open it in Chrome with DevTools open and audit it from there, or allow it with ` +
        `--audit-allow-origin.`
    );
  }

  function broadcast(message: unknown): void {
    for (const connection of connections.values()) send(connection.ws, message);
  }

  // --------------------------------------------------------------- listen

  const actualPortHolder = { value: 0 };
  await listen(server, host, config.port ?? 3025).then((p) => (actualPortHolder.value = p));
  const actualPort = actualPortHolder.value;

  log.info(`Connector listening on http://${host}:${actualPort}`);

  function devtoolsConnections(): ExtensionConnection[] {
    return [...connections.values()].filter((connection) => connection.role !== "worker");
  }

  function telemetryConnected(): boolean {
    return devtoolsConnections().some((connection) => connection.ws.readyState === WebSocket.OPEN);
  }

  function workerConnection(): ExtensionConnection | undefined {
    return [...connections.values()].find(
      (connection) =>
        connection.role === "worker" &&
        connection.fromExtension &&
        connection.ws.readyState === WebSocket.OPEN
    );
  }

  function denyCheck(action: string, reason: string): CapabilityCheck {
    return { allowed: false, action, reason, liveUrl: null };
  }

  async function checkCapability(
    action: CapabilityAction,
    options: { tabId?: TabId; destinationUrl?: string; hideBanner?: boolean } = {}
  ): Promise<CapabilityCheck> {
    if (options.hideBanner === true) return denyCheck(action, GateReason.banner);
    if (excludeListInvalid) return denyCheck(action, GateReason.excludeInvalid);

    const needsPopup = isNoDevtoolsAction(action);
    const needsPanel = (PANEL_ACTIONS as readonly string[]).includes(action);
    const needsInput = (INPUT_ACTIONS as readonly string[]).includes(action);
    const needsEval = action === "evaluateScript";

    // Refuse before asking the extension to read a tab when a switch or flag is off.
    if (needsPopup && !popupEnabled) return denyCheck(action, GateReason.popupOff);
    if (needsPanel && !panelEnabled) return denyCheck(action, GateReason.panelOff);
    if (needsInput && !capabilityPolicy.allowInput) return denyCheck(action, GateReason.inputOff);
    if (needsEval && !capabilityPolicy.allowEval) return denyCheck(action, GateReason.evalOff);

    const worker = workerConnection();
    if (!worker) {
      return denyCheck(action, action === "listTabs" ? GateReason.switchUnconfirmed : GateReason.notRechecked);
    }

    let probe: Record<string, unknown>;
    try {
      probe = await requestFromExtension(worker, "capability-probe", {
        action,
        ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
      });
    } catch {
      return denyCheck(action, action === "listTabs" ? GateReason.switchUnconfirmed : GateReason.notRechecked);
    }

    const probePopup = probe["popupEnabled"] === true;
    const probePanel = probe["panelEnabled"] === true;
    const liveUrl = typeof probe["liveUrl"] === "string" && probe["liveUrl"] ? probe["liveUrl"] : null;
    const reportedExclude = Array.isArray(probe["excludeOrigins"])
      ? probe["excludeOrigins"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const normalizedExclude = normalizeOriginList(reportedExclude);
    if (normalizedExclude.rejected.length > 0) return denyCheck(action, GateReason.excludeInvalid);

    if (needsPopup && !probePopup) return denyCheck(action, GateReason.popupOff);
    if (needsPanel && !probePanel) return denyCheck(action, GateReason.panelOff);

    const decision = decideCapability(action, {
      policy: {
        ...capabilityPolicy,
        excludeOrigins: [...new Set([...capabilityPolicy.excludeOrigins, ...normalizedExclude.origins])],
      },
      popupEnabled: probePopup,
      panelEnabled: probePanel,
      liveUrl,
      destinationUrl: options.destinationUrl ?? null,
    });

    return { allowed: decision.allowed, action, reason: decision.reason, liveUrl };
  }

  async function close(): Promise<void> {
    clearInterval(heartbeat);
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Connector shutting down"));
    }
    pending.clear();

    for (const connection of connections.values()) {
      try {
        connection.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    connections.clear();

    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // server.close() only stops accepting new connections and then waits for
    // existing ones to end. A browser that is still shutting down keeps
    // reconnecting, so without this the port can stay bound long after close()
    // resolves — or close() never resolves at all.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    app,
    server,
    store,
    port: actualPort,
    host,
    token,
    screenshotDir,
    hasExtension: () => telemetryConnected(),
    checkCapability,
    listTabs,
    getCurrentTabId: () => currentTabId,
    setCurrentTab,
    queryConsole,
    queryNetwork,
    getSelectedElement,
    exportConsole,
    exportNetwork,
    readArtifact,
    captureScreenshot,
    refreshTab,
    readStorage,
    runAudit,
    close,
  };
}

// ---------------------------------------------------------------- utilities

function respondWithError(res: Response, error: unknown): void {
  if (error instanceof UnknownTabError) {
    res.status(404).json({ error: error.message, code: "UNKNOWN_TAB" });
    return;
  }
  if (error instanceof AuditError) {
    res.status(422).json({ error: error.message, code: "AUDIT_FAILED" });
    return;
  }
  if (error instanceof UnsafePathError) {
    res.status(400).json({ error: error.message, code: "UNSAFE_PATH" });
    return;
  }
  if (error instanceof NoExtensionError) {
    res.status(503).json({ error: error.message, code: "NO_EXTENSION" });
    return;
  }
  if (error instanceof ExtensionTimeoutError) {
    res.status(504).json({ error: error.message, code: "EXTENSION_TIMEOUT" });
    return;
  }
  if (error instanceof ExtensionRequestError) {
    res.status(502).json({ error: error.message, code: "EXTENSION_ERROR" });
    return;
  }
  log.error("Unexpected error:", error);
  res.status(500).json({ error: (error as Error)?.message ?? "Internal error" });
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    log.warn("Failed to send to extension:", error);
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch {
    /* socket already gone */
  }
}

/** Keeps one noisy entry from taking over the terminal. */
function clip(value: string, limit = 160): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function asEntries(message: Record<string, unknown>): unknown[] {
  const entries = message["entries"];
  if (Array.isArray(entries)) return entries;
  if (message["entry"] !== undefined) return [message["entry"]];
  return [];
}

/** Reads tabId / allTabs from a query string. */
function parseTabScope(query: Record<string, unknown>): { tabId?: TabId; allTabs?: boolean } {
  const out: { tabId?: TabId; allTabs?: boolean } = {};
  const raw = query["tabId"];
  if (typeof raw === "string" && raw.length > 0) {
    const asNumber = Number(raw);
    out.tabId = Number.isFinite(asNumber) ? asNumber : raw;
  }
  const allTabs = parseBool(query["allTabs"]);
  if (allTabs !== undefined) out.allTabs = allTabs;
  return out;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseCount(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length ? items : undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    const items = value.split(",").map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  return undefined;
}

/** Consecutive ports tried when the requested one is already taken. */
export const CONNECTOR_BIND_ATTEMPTS = 11;

/** Binds the requested port, walking forward if it is taken. */
function listen(
  server: http.Server,
  host: string,
  startPort: number,
  attempts = CONNECTOR_BIND_ATTEMPTS
): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let remaining = attempts;

    const tryListen = () => {
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      };

      const onError = (error: NodeJS.ErrnoException) => {
        // listen() registers onListening before the bind is attempted. A
        // failed attempt leaves it in place, so a walk across taken ports
        // stacks one listener per try and every one of them runs if a later
        // port succeeds.
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && remaining > 1 && startPort !== 0) {
          remaining -= 1;
          port += 1;
          setImmediate(tryListen);
          return;
        }
        reject(error);
      };

      server.once("error", onError);
      server.listen(port, host, onListening);
    };

    tryListen();
  });
}
