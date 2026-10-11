import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createLogger } from "../util/logger.js";
import {
  destinationKey,
  destinationKeyOf,
  normalizeHost,
  resolveDestination,
  systemLookup,
  type AddressClass,
  type Lookup,
  type ResolvedDestination,
} from "./destination.js";

const log = createLogger("lighthouse");

/**
 * A forward proxy that every request from the audit browser is sent through.
 *
 * Checking the audit url up front is not enough on its own: Chrome follows
 * redirects, loads subresources and frames, and resolves DNS again after any
 * check of ours — so a public page could redirect or frame its way to
 * 169.254.169.254 or a LAN host, and a rebinding name could change address
 * between our lookup and Chrome's. Routing the browser through this proxy
 * puts one checkpoint in front of all of it:
 *
 * - each request's host is resolved and classified here, not by Chrome;
 * - the connection goes to an address that was checked, so there is no
 *   second lookup to rebind;
 * - redirects, frames, fetches and websockets all arrive as new requests and
 *   are held to the same rule.
 */
export interface EgressPolicy {
  /** Every loopback and private destination allowed (blocked ones never are). */
  allowPrivate: boolean;
  /**
   * Loopback and private origins allowed one at a time when `allowPrivate` is
   * off — the audited page's own origin and the others vouched for with it.
   * Trusting one local origin must not open every other one: a dev server's
   * open redirect or a framed page would otherwise reach the router, another
   * local service, or the audit browser's own debugging port. Matched by
   * host:port (see `destinationKey`).
   */
  allowedOrigins?: string[];
  /** Injectable for tests. */
  lookup?: Lookup;
  /** How long one connection attempt to one address may take. */
  connectTimeoutMs?: number;
}

export interface EgressProxy {
  port: number;
  /** Requests refused, for diagnostics and tests. */
  refused: Array<{ host: string; class: AddressClass }>;
  close(): Promise<void>;
}

/** Refusals recorded and logged per audit; a hostile page can invent hostnames without end. */
const MAX_REPORTED_REFUSALS = 100;

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const match = authority.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? authority.match(/^([^:]+)(?::(\d+))?$/);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!, port };
}

/**
 * Connects to the first address that answers, trying them in order.
 *
 * A browser does this itself (localhost is both 127.0.0.1 and ::1, and a dev
 * server is often bound to only one of them); once the browser is behind the
 * proxy, the proxy has to. Every address here has already been vetted: the
 * host's class is the worst of all of them, so none is worse than permitted.
 */
function dial(addresses: string[], port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const errors: string[] = [];
    const attempt = (index: number) => {
      const address = addresses[index];
      if (address === undefined) {
        reject(new Error(errors.join("; ") || "no address to connect to"));
        return;
      }
      const socket = net.connect({ host: address, port });
      const fail = (reason: string) => {
        socket.destroy();
        errors.push(`${address}: ${reason}`);
        attempt(index + 1);
      };
      socket.setTimeout(timeoutMs, () => fail("connect timed out"));
      socket.once("error", (error) => fail(error.message));
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        resolve(socket);
      });
    };
    attempt(0);
  });
}

export async function startEgressProxy(policy: EgressPolicy): Promise<EgressProxy> {
  const lookup = policy.lookup ?? systemLookup;
  const connectTimeoutMs = policy.connectTimeoutMs ?? 10_000;
  const refused: EgressProxy["refused"] = [];
  const warned = new Set<string>();
  const allowedLocal = new Set(
    (policy.allowedOrigins ?? []).map((origin) => destinationKeyOf(origin)).filter((key) => key !== null)
  );

  // One answer per host for the whole audit. A page asks for the same hosts
  // over and over, and a lookup per request would slow down the very loads a
  // performance audit is timing. It also keeps every request to a host on the
  // addresses that were checked first.
  const resolved = new Map<string, Promise<ResolvedDestination>>();
  const resolve = (host: string) => {
    const key = normalizeHost(host);
    let pending = resolved.get(key);
    if (!pending) {
      pending = resolveDestination(key, lookup);
      resolved.set(key, pending);
    }
    return pending;
  };

  function permitted(dest: ResolvedDestination, port: number): boolean {
    if (dest.class === "blocked") return false;
    if (dest.class === "public") return true;
    return policy.allowPrivate || allowedLocal.has(destinationKey(dest.host, port));
  }

  /** Resolves, classifies and returns the vetted addresses to connect to, or null. */
  async function vet(host: string, port: number): Promise<string[] | null> {
    const dest = await resolve(host);
    if (!permitted(dest, port)) {
      // Once per destination, and only so many: a hostile page can ask for
      // thousands of subresources, from as many made-up hostnames.
      const label = dest.class === "blocked" ? dest.host : `${dest.host}:${port}`;
      if (!warned.has(label) && warned.size < MAX_REPORTED_REFUSALS) {
        warned.add(label);
        refused.push({ host: dest.host, class: dest.class });
        log.warn(`Audit browser blocked from ${label} (${dest.class} address)`);
      }
      return null;
    }
    return dest.addresses.length > 0 ? dest.addresses : null;
  }

  // Upstream plain-http connections are pooled per host:port, as Chrome's own
  // would be, so a performance audit measures the page and not the proxy. The
  // agent dials vetted addresses only and is destroyed with the proxy.
  const agent = new http.Agent({ keepAlive: true });
  type DialOptions = net.NetConnectOpts & { vetted?: string[]; port?: number };
  (agent as unknown as { createConnection: unknown }).createConnection = (
    options: DialOptions,
    callback: (error: Error | null, socket?: net.Socket) => void
  ) => {
    dial(options.vetted ?? [], Number(options.port), connectTimeoutMs).then(
      (socket) => callback(null, socket),
      (error: Error) => callback(error)
    );
  };

  const server = http.createServer(async (req, res) => {
    // Plain-http requests arrive in absolute form: GET http://host:port/path
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    const vetted = await vet(target.hostname, port);
    if (!vetted) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Blocked by browser-tools-mcp audit policy");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        agent,
        host: target.hostname,
        port,
        vetted,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
      } as http.RequestOptions,
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // https and websockets arrive as CONNECT host:port
  server.on("connect", async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    const authority = splitHostPort(req.url ?? "", 443);
    const vetted = authority ? await vet(authority.host, authority.port) : null;
    if (!authority || !vetted) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    let upstream: net.Socket;
    try {
      upstream = await dial(vetted, authority.port, connectTimeoutMs);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    track(upstream);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  // CONNECT tunnels are not tracked by server.closeAllConnections(), and
  // Chrome keeps some open for minutes (push messaging), so close() destroys
  // every socket itself rather than waiting on them.
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
        agent.destroy();
      }),
  };
}

/** Chrome flags that send every request, loopback included, through the proxy. */
export function proxyChromeFlags(port: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    // Chrome bypasses proxies for localhost, 127.0.0.1, ::1 and link-local
    // addresses unless told otherwise; <-loopback> removes all of those
    // implicit bypass rules, link-local included (that is where cloud metadata
    // lives). The e2e suite checks this against a real browser.
    "--proxy-bypass-list=<-loopback>",
    // WebRTC sends UDP straight past an HTTP proxy, so a page could probe
    // internal hosts and ports with STUN/TURN. This leaves WebRTC only the
    // TCP path through the proxy, where the same rule applies. Set again as a
    // preference below; the e2e suite checks that no UDP gets out.
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/**
 * Profile preferences for the audit browser. The WebRTC policy is set here as
 * well as on the command line because the switch has been renamed (current
 * Chrome no longer knows --force-webrtc-ip-handling-policy) while the
 * preference has not, and the audit may run in any installed Chromium-based
 * browser.
 */
export const AUDIT_BROWSER_PREFS = { webrtc: { ip_handling_policy: "disable_non_proxied_udp" } };
