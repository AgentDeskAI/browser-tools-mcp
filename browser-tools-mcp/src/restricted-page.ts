/**
 * Pages an extension cannot script.
 *
 * Tab lists, page info, and navigation all use this shape so agents see the
 * same fields everywhere (AGE-259, and AGE-584's tab list and background
 * navigate). `message` is the shared wording: metadata only, the page cannot
 * be read or acted on.
 */

export const RESTRICTED_PAGE_ACCESS = "metadata-only" as const;

export const RESTRICTED_PAGE_MESSAGE = "metadata only, can't read or act";

/** Chromium's built-in PDF viewer extension. Stable across Chrome releases. */
export const CHROMIUM_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

export const RESTRICTED_PAGE_KINDS = [
  "chrome",
  "devtools",
  "view-source",
  "web-store",
  "pdf",
  "extension",
  "browser",
] as const;

export type RestrictedPageKind = (typeof RESTRICTED_PAGE_KINDS)[number];

export interface RestrictedPageReport {
  access: typeof RESTRICTED_PAGE_ACCESS;
  message: typeof RESTRICTED_PAGE_MESSAGE;
  scriptable: false;
  kind: RestrictedPageKind;
  /** The page that cannot be scripted. */
  url: string;
  /** Which kind of page this is, in one sentence. */
  detail: string;
}

/** Fields spread onto a tab or page record. Omitted entirely for a normal page. */
export type RestrictedPageFields =
  | {
      access: typeof RESTRICTED_PAGE_ACCESS;
      message: typeof RESTRICTED_PAGE_MESSAGE;
      scriptable: false;
      kind: RestrictedPageKind;
      detail: string;
    }
  | Record<string, never>;

const DETAILS: Record<RestrictedPageKind, string> = {
  chrome: "Browser pages such as chrome:// cannot be scripted.",
  devtools: "DevTools pages cannot be scripted.",
  "view-source": "view-source: pages cannot be scripted.",
  "web-store": "The Chrome Web Store cannot be scripted.",
  pdf: "The built-in PDF viewer cannot be scripted.",
  extension: "Extension pages cannot be scripted.",
  browser: "This browser page cannot be scripted.",
};

const SCHEMES: Record<string, RestrictedPageKind> = {
  "chrome:": "chrome",
  "chrome-untrusted:": "chrome",
  "chrome-search:": "chrome",
  "chrome-error:": "chrome",
  "devtools:": "devtools",
  "view-source:": "view-source",
  "edge:": "browser",
  "brave:": "browser",
  "arc:": "browser",
  "opera:": "browser",
  "vivaldi:": "browser",
  "browser:": "browser",
  "about:": "browser",
  "chrome-extension:": "extension",
  "moz-extension:": "extension",
  "safari-web-extension:": "extension",
  "edge-extension:": "extension",
  "data:": "browser",
  "blob:": "browser",
  "javascript:": "browser",
};

const KIND_SET = new Set<string>(RESTRICTED_PAGE_KINDS);

function isPdfPath(pathname: string): boolean {
  return /\.pdf$/i.test(pathname.replace(/\/+$/, ""));
}

function isWebStore(parsed: URL): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "chromewebstore.google.com") return true;
  if (host !== "chrome.google.com") return false;
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
  return path === "/webstore" || path.startsWith("/webstore/");
}

function detailFor(kind: RestrictedPageKind, parsed: URL): string {
  if (parsed.protocol === "chrome-error:") return "Chrome's error page cannot be scripted.";
  return DETAILS[kind];
}

function report(kind: RestrictedPageKind, parsed: URL): RestrictedPageReport {
  return {
    access: RESTRICTED_PAGE_ACCESS,
    message: RESTRICTED_PAGE_MESSAGE,
    scriptable: false,
    kind,
    url: parsed.href,
    detail: detailFor(kind, parsed),
  };
}

/**
 * Classifies a URL the extension cannot script, or null when it can (or the
 * value is not a URL). about:blank is left alone: extensions can script it.
 */
export function restrictedPage(url: string | null | undefined): RestrictedPageReport | null {
  if (url == null || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol === "about:" && parsed.pathname === "blank") return null;

  if (
    parsed.protocol === "chrome-extension:" &&
    parsed.hostname.toLowerCase() === CHROMIUM_PDF_VIEWER_ID
  ) {
    return report("pdf", parsed);
  }

  const byScheme = SCHEMES[parsed.protocol];
  if (byScheme) return report(byScheme, parsed);
  if (isWebStore(parsed)) return report("web-store", parsed);
  if (isPdfPath(parsed.pathname)) return report("pdf", parsed);
  return null;
}

export function restrictedPageFields(url: string | null | undefined): RestrictedPageFields {
  const found = restrictedPage(url);
  if (!found) return {};
  return {
    access: found.access,
    message: found.message,
    scriptable: false,
    kind: found.kind,
    detail: found.detail,
  };
}

/**
 * An http(s) PDF can still be opened in the tab. The viewer cannot be
 * scripted, which is reported after the load. Every other restricted URL is
 * refused before navigation.
 */
export function loadsWithoutScripting(url: string | null | undefined): boolean {
  const found = restrictedPage(url);
  if (!found || found.kind !== "pdf") return false;
  try {
    const protocol = new URL(url!.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const URL_IN_TEXT =
  /(?:^|[\s"'`(])((?:[a-z][a-z0-9+.-]*:\/\/|view-source:)[^\s"'`<>)]*)/gi;

/** Turns a Chrome refusal that names one of these pages into the shared report. */
export function restrictedPageFromExtensionError(message: string): RestrictedPageReport | null {
  for (const match of message.matchAll(URL_IN_TEXT)) {
    const found = restrictedPage(match[1]);
    if (found) return found;
  }
  if (/extensions gallery cannot be scripted/i.test(message)) {
    return restrictedPage("https://chrome.google.com/webstore");
  }
  return null;
}

export interface RestrictedPageErrorOptions {
  /** The tab already moved to this URL. */
  navigated?: boolean;
  tabId?: number | string;
  requestedUrl?: string;
  wasDiscarded?: boolean;
}

export class RestrictedPageError extends Error {
  readonly report: RestrictedPageReport;
  readonly navigated: boolean;
  readonly tabId?: number | string;
  readonly requestedUrl?: string;
  readonly wasDiscarded?: boolean;

  constructor(found: RestrictedPageReport, options: RestrictedPageErrorOptions = {}) {
    const landed = options.navigated === true;
    super(
      landed
        ? `The tab is on ${found.url}, but it is ${found.message}. ${found.detail}`
        : `${found.message}. ${found.detail}`
    );
    this.name = "RestrictedPageError";
    this.report = found;
    this.navigated = landed;
    if (options.tabId !== undefined) this.tabId = options.tabId;
    if (options.requestedUrl) this.requestedUrl = options.requestedUrl;
    if (options.wasDiscarded !== undefined) this.wasDiscarded = options.wasDiscarded;
  }

  /** The fields agents and the local API share. */
  toJSON(): Record<string, unknown> {
    return {
      access: this.report.access,
      message: this.report.message,
      scriptable: false,
      kind: this.report.kind,
      url: this.report.url,
      detail: this.report.detail,
      navigated: this.navigated,
      ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
      ...(this.requestedUrl ? { requestedUrl: this.requestedUrl } : {}),
      ...(this.navigated ? { finalUrl: this.report.url } : {}),
      ...(this.wasDiscarded !== undefined ? { wasDiscarded: this.wasDiscarded } : {}),
    };
  }
}

export function restrictedPageErrorFromPayload(
  payload: Record<string, unknown>
): RestrictedPageError | null {
  if (payload["code"] !== "RESTRICTED_PAGE") return null;
  const kind = payload["kind"];
  const url = payload["url"];
  if (typeof kind !== "string" || !KIND_SET.has(kind) || typeof url !== "string") return null;
  const found = restrictedPage(url);
  const report: RestrictedPageReport = found ?? {
    access: RESTRICTED_PAGE_ACCESS,
    message: RESTRICTED_PAGE_MESSAGE,
    scriptable: false,
    kind: kind as RestrictedPageKind,
    url,
    detail: typeof payload["detail"] === "string" ? payload["detail"] : DETAILS[kind as RestrictedPageKind],
  };
  const tabId = payload["tabId"];
  return new RestrictedPageError(report, {
    navigated: payload["navigated"] === true,
    ...(typeof tabId === "number" || typeof tabId === "string" ? { tabId } : {}),
    ...(typeof payload["requestedUrl"] === "string" ? { requestedUrl: payload["requestedUrl"] } : {}),
    ...(typeof payload["wasDiscarded"] === "boolean" ? { wasDiscarded: payload["wasDiscarded"] } : {}),
  });
}

/** Tool text: the sentence, then the shared JSON object. */
export function restrictedPageToolText(error: RestrictedPageError): string {
  return `${error.message}\n${JSON.stringify(error.toJSON(), null, 2)}`;
}
