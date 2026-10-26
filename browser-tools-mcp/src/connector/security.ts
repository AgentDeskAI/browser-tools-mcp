import type { Request, Response, NextFunction } from "express";
import { tokensMatch } from "../util/session.js";

/** Hostnames a request is allowed to arrive as. Anything else is a rebind. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The websocket subprotocol the extension offers alongside its token.
 * The server selects this name, so the token itself is not echoed back.
 */
export const WEBSOCKET_PROTOCOL = "browser-tools";

/** A real Chromium extension id: 32 characters from a-p. Used by tests too. */
export const EXAMPLE_CHROME_EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

export const EXAMPLE_FIREFOX_EXTENSION_ORIGIN =
  "moz-extension://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const EXAMPLE_SAFARI_EXTENSION_ORIGIN =
  "safari-web-extension://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CHROME_EXTENSION_ID = /^[a-p]{32}$/;
const EXTENSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ExtensionOrigin {
  scheme: "chrome-extension" | "moz-extension" | "safari-web-extension";
  id: string;
}

/**
 * A browser-extension origin, and nothing looser.
 *
 * The id has to be one a browser would actually assign: 32 characters from
 * a-p for Chromium, a UUID for Firefox and Safari. The generic `extension://`
 * scheme is not one of those, and neither is an origin that carries a path,
 * query, port or userinfo — a page's Origin header never looks like that.
 */
export function parseExtensionOrigin(origin: string | undefined | null): ExtensionOrigin | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.pathname !== "") return null;

  const scheme = url.protocol.slice(0, -1);
  if (scheme === "chrome-extension") {
    if (!CHROME_EXTENSION_ID.test(url.hostname)) return null;
    return { scheme, id: url.hostname };
  }
  if (scheme === "moz-extension" || scheme === "safari-web-extension") {
    const id = url.hostname.toLowerCase();
    if (!EXTENSION_UUID.test(id)) return null;
    return { scheme, id };
  }
  return null;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isExtensionOrigin(origin: string | undefined | null): boolean {
  return parseExtensionOrigin(origin) !== null;
}

/**
 * `extensionId` may be a bare id or a full origin. Unset means any extension
 * origin that {@link parseExtensionOrigin} accepts.
 */
export function extensionOriginAllowed(
  origin: string | undefined | null,
  extensionId?: string
): boolean {
  const parsed = parseExtensionOrigin(origin);
  if (!parsed) return false;
  const configured = extensionId?.trim();
  if (!configured) return true;
  const asOrigin = parseExtensionOrigin(configured);
  if (asOrigin) return asOrigin.scheme === parsed.scheme && asOrigin.id === parsed.id;
  return configured.toLowerCase() === parsed.id;
}

/** The token from `Authorization: Bearer <token>`, or "" when the header is not that. */
export function bearerToken(authorization: string | undefined): string {
  if (!authorization) return "";
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  return match?.[1] ?? "";
}

/** Protocol tokens other than {@link WEBSOCKET_PROTOCOL}, which is not a secret. */
export function websocketProtocolTokens(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== WEBSOCKET_PROTOCOL);
}

export function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  return ALLOWED_HOSTNAMES.has(hostnameOf(hostHeader));
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  // Strip the port; keep bracketed IPv6 intact.
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/**
 * Rejects requests that did not come from this machine addressed as localhost,
 * and any request carrying a web-page Origin.
 *
 * Together these close the cross-site path that made every endpoint reachable
 * from any page the user happened to visit.
 */
export function localOnlyGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
    if (!isAllowedHostHeader(hostHeader)) {
      res.status(403).json({
        error: "Requests must address this server as localhost",
        code: "FORBIDDEN_HOST",
      });
      return;
    }

    const origin = req.headers.origin;
    if (Array.isArray(origin) || (origin && !isExtensionOrigin(origin))) {
      res.status(403).json({
        error: "Cross-origin requests are not accepted",
        code: "FORBIDDEN_ORIGIN",
      });
      return;
    }

    next();
  };
}

/**
 * Requires a bearer token on the API surface.
 *
 * A token in the query string is refused even when the header is also
 * correct. URLs are copied into logs, history and Referer, and the query
 * form was a second way in that did not need to be.
 */
export function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.query["token"] !== undefined) {
      res.status(401).json({
        error: "The token must be sent as an Authorization bearer token, not in the URL",
        code: "TOKEN_IN_URL",
      });
      return;
    }

    const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const presented = bearerToken(header);
    if (!presented || !tokensMatch(presented, token)) {
      res.status(401).json({
        error: "Missing or invalid authorization token",
        code: "UNAUTHORIZED",
      });
      return;
    }
    next();
  };
}
