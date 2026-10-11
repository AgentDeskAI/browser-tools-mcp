import { createLogger } from "../util/logger.js";
import { extractAuditReport } from "./extract.js";
import { describeLaunchFailure, findAuditBrowser, NoBrowserError, type FoundBrowser } from "./find-browser.js";
import { resolveDestination, type Lookup } from "./destination.js";
import { AUDIT_BROWSER_PREFS, proxyChromeFlags, startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import type { AuditCategory, AuditReport, LighthouseResultLike } from "./types.js";

const log = createLogger("lighthouse");

export interface AuditHooks {
  /** Receives the unabridged Lighthouse result, for persisting as an artifact. */
  onRawResult?: (lhr: unknown) => void;
}

export interface AuditOptions {
  url: string;
  category: AuditCategory;
  /** "desktop" (default) or "mobile". */
  device?: "desktop" | "mobile";
  timeoutMs?: number;
  /**
   * Where the audit browser may go, decided by the caller. Blocked addresses
   * (link-local, metadata, multicast, reserved) are always refused. Loopback
   * and private addresses are refused except for the origins in
   * `allowedOrigins`, or all of them when `allowPrivate` is true; `{}` allows
   * nothing local.
   *
   * Required, and used exactly as given. The runner looks the audited host up
   * again, and that answer must never widen the decision: a rebinding name can
   * answer "public" to the connector, which then allows nothing local, and
   * "loopback" a moment later to the runner.
   */
  egress: { allowPrivate?: boolean; allowedOrigins?: string[]; lookup?: Lookup };
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

/** Screen, throttling and user agent have to describe the same device. */
const DEVICE_PROFILES = {
  desktop: {
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttlingPreset: "desktopDense4G",
  },
  mobile: {
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
    throttlingPreset: "mobileSlow4G",
  },
} as const;

/**
 * Lighthouse's own presets, so an audit and any future emulation agree on what
 * "mobile" means rather than each carrying its own numbers.
 *
 * Loaded on demand and memoised. A static import costs ~30ms at startup,
 * because the connector imports this module eagerly and only audits ever need
 * these values — and answering `initialize` promptly is the reason the second
 * process went away.
 */
let devicePresets: Promise<{ throttling: any; userAgents: any }> | undefined;

function loadDevicePresets() {
  devicePresets ??= import("lighthouse/core/config/constants.js").then((m) => {
    const c = (m as any).default ?? m;
    return { throttling: c.throttling, userAgents: c.userAgents };
  });
  return devicePresets;
}

export interface LighthouseFlagOptions {
  category: AuditCategory;
  device: "desktop" | "mobile";
  port: number;
  timeoutMs: number;
}

/**
 * Builds the flags for a run.
 *
 * formFactor and screenEmulation were set but throttling and emulatedUserAgent
 * were not, so a desktop audit ran a desktop viewport under Lighthouse's
 * default mobile Slow-4G throttling while identifying itself as a phone —
 * three settings disagreeing about the device, and a score shaped by whichever
 * one mattered most.
 */
export async function buildLighthouseFlags(options: LighthouseFlagOptions) {
  const profile = DEVICE_PROFILES[options.device];
  const { throttling, userAgents } = await loadDevicePresets();
  return {
    port: options.port,
    output: "json" as const,
    logLevel: "error" as const,
    onlyCategories: [options.category],
    formFactor: options.device,
    screenEmulation: profile.screenEmulation,
    throttling: throttling[profile.throttlingPreset],
    emulatedUserAgent: userAgents[options.device],
    maxWaitForLoad: options.timeoutMs,
  };
}

/** Only real web pages can be audited; anything else is a configuration mistake. */
export function assertAuditableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuditError(`Not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AuditError(
      `Cannot audit ${parsed.protocol} URLs — navigate to an http(s) page first.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new AuditError("Cannot audit a URL that embeds credentials.");
  }
  return parsed;
}

/**
 * Why a page that never loaded may have failed. The proxy cannot tell the
 * document's request from the page's subresources or the browser's own
 * background traffic, so this names everything refused rather than guessing
 * which one mattered.
 */
export function describeRefusals(
  refused: EgressProxy["refused"],
  lighthouseMessage: string | undefined
): string {
  const labels = [
    ...new Set(
      refused.map((r) =>
        r.unresolved ? `${r.host} (does not resolve)` : r.class === "blocked" ? r.host : `${r.host}:${r.port}`
      )
    ),
  ];
  const shown = labels.slice(0, 10).join(", ") + (labels.length > 10 ? ` and ${labels.length - 10} more` : "");
  return (
    `The audited page did not load. This audit tried to reach ${shown}, which audits are not allowed to load.` +
    (lighthouseMessage ? ` (Lighthouse: ${lighthouseMessage})` : "")
  );
}

/**
 * Lighthouse runtime errors that mean the page itself never loaded. Only
 * these are reported with the refused requests (see `describeRefusals`); a
 * page that loaded and then failed some other way keeps Lighthouse's own
 * explanation.
 */
const DOCUMENT_LOAD_FAILURES = new Set([
  "NO_DOCUMENT_REQUEST",
  "FAILED_DOCUMENT_REQUEST",
  "ERRORED_DOCUMENT_REQUEST",
  "CHROME_INTERSTITIAL_ERROR",
]);

const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--mute-audio",
];

/**
 * Runs Lighthouse against a freshly launched headless Chrome.
 *
 * Chrome and Lighthouse are imported lazily so that a partial install degrades
 * to "audits unavailable" instead of preventing the whole server from starting.
 */
export async function runLighthouseAudit(
  options: AuditOptions,
  hooks: AuditHooks = {}
): Promise<AuditReport> {
  const { category, device = "desktop", timeoutMs = 60_000 } = options;
  const parsed = assertAuditableUrl(options.url);
  const url = parsed.toString();

  // Fails fast, before a browser starts, saying which of the two it is.
  const top = await resolveDestination(parsed.hostname, options.egress.lookup);
  if (top.unresolved) {
    throw new AuditError(
      `Cannot audit ${parsed.hostname}: the name does not resolve. Check the url, or try again if the ` +
        `network was briefly down.`
    );
  }
  if (top.class === "blocked") {
    throw new AuditError(
      `Refusing to audit ${parsed.hostname}: it resolves to a link-local, metadata or reserved address.`
    );
  }

  let chrome: { port: number; kill: () => Promise<void> } | undefined;
  let chosen: FoundBrowser | undefined;
  let proxy: EgressProxy | undefined;

  try {
    proxy = await startEgressProxy({
      allowPrivate: options.egress.allowPrivate ?? false,
      allowedOrigins: options.egress.allowedOrigins ?? [],
      ...(options.egress.lookup ? { lookup: options.egress.lookup } : {}),
    });

    const [chromeLauncher, lighthouseModule] = await Promise.all([
      import("chrome-launcher"),
      import("lighthouse"),
    ]);
    const lighthouse = (lighthouseModule.default ?? lighthouseModule) as any;

    // chrome-launcher only knows about Chrome and Chromium. Anyone running Arc,
    // Brave or Edge with no Chrome installed would otherwise lose every audit.
    const browser = findAuditBrowser({
      installed: () => (chromeLauncher as any).Launcher?.getInstallations?.() ?? [],
    });
    chosen = browser;
    log.debug(`Running the audit in ${browser.name} (${browser.source})`);

    chrome = (await chromeLauncher.launch({
      chromeFlags: [...CHROME_FLAGS, ...proxyChromeFlags(proxy.port)],
      chromePath: browser.path,
      prefs: AUDIT_BROWSER_PREFS,
    })) as unknown as { port: number; kill: () => Promise<void> };
    // The audit browser's own DevTools port is the audit's machinery, not a
    // page, whatever the policy allows.
    proxy.refusePort(chrome.port);

    const flags = await buildLighthouseFlags({ category, device, port: chrome.port, timeoutMs });

    const result = (await withTimeout(
      lighthouse(url, flags),
      timeoutMs + 15_000,
      `Lighthouse did not finish within ${Math.round((timeoutMs + 15_000) / 1000)}s`
    )) as { lhr?: LighthouseResultLike } | undefined;

    const lhr = result?.lhr;
    if (!lhr) throw new AuditError("Lighthouse returned no result");
    const runtimeError = (lhr as { runtimeError?: { code?: string; message?: string } }).runtimeError;
    if (runtimeError && DOCUMENT_LOAD_FAILURES.has(runtimeError.code ?? "") && proxy.refused.length > 0) {
      throw new AuditError(describeRefusals(proxy.refused, runtimeError.message));
    }

    hooks.onRawResult?.(lhr);
    return extractAuditReport(lhr, url, category, device);
  } catch (error) {
    if (error instanceof AuditError) throw error;
    // Already a clear, actionable explanation; do not bury it.
    if (error instanceof NoBrowserError) throw new AuditError(error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) {
      throw new AuditError(
        "Lighthouse or Chrome is not available in this install, so audits cannot run."
      );
    }
    if (/No Chrome installations found|ChromePathNotSet/i.test(message)) {
      throw new AuditError(
        "No Chromium-based browser could be launched for the audit. Set CHROME_PATH to the " +
          "executable of a browser you have installed."
      );
    }
    // A browser that was located but never opened its debugging port.
    if (chosen && /ECONNREFUSED|Failed to launch|spawn|SIGABRT|socket hang up/i.test(message)) {
      throw new AuditError(describeLaunchFailure(chosen, message));
    }
    throw new AuditError(`${category} audit failed: ${message}`);
  } finally {
    if (chrome) {
      try {
        await chrome.kill();
      } catch (error) {
        log.warn("Could not shut down the audit Chrome instance:", error);
      }
    }
    await proxy?.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuditError(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
