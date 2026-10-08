import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { browserAvailability } from "../helpers/browser-available";
import { chromium } from "playwright";

import { runLighthouseAudit, AuditError, assertAuditableUrl } from "../../src/lighthouse/runner";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Actually runs Lighthouse.
 *
 * The extractor is unit-tested against a fixture, but that proves nothing about
 * whether Chrome launches, whether the Lighthouse flags are still valid for the
 * installed version, or whether a real result has the shape the extractor
 * expects. Four of the fifteen tools depend on this path.
 */

// Skips rather than fails where no browser can start — see the helper.
const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();

  // chrome-launcher looks for a system Chrome. In CI, and on a machine without
  // Chrome installed, point it at the browser Playwright already downloaded.
  if (!process.env["CHROME_PATH"]) {
    process.env["CHROME_PATH"] = chromium.executablePath();
  }
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

describe.skipIf(!browserSupport.usable)("lighthouse audits against a real page", () => {
  it("runs an accessibility audit and returns a usable report", async () => {
    const report = await runLighthouseAudit({
      url: fixture.url,
      category: "accessibility",
    });

    expect(report.category).toBe("accessibility");
    expect(report.metadata.url).toContain("127.0.0.1");
    expect(report.metadata.lighthouseVersion).toMatch(/^\d+\./);

    // A real score, not a placeholder.
    expect(report.score).toBeTypeOf("number");
    expect(report.score!).toBeGreaterThanOrEqual(0);
    expect(report.score!).toBeLessThanOrEqual(100);

    // The fixture page has an image with no alt text, so there is something to find.
    const total =
      report.summary.failed + report.summary.passed + report.summary.notApplicable;
    expect(total).toBeGreaterThan(0);

    for (const issue of report.issues) {
      expect(issue.id).toBeTruthy();
      expect(issue.title).toBeTruthy();
      expect(["critical", "serious", "moderate", "minor"]).toContain(issue.impact);
    }
  }, 180_000);

  it("finds the missing alt attribute on the fixture page", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "accessibility" });
    const ids = report.issues.map((issue) => issue.id);
    expect(ids).toContain("image-alt");
  }, 180_000);

  it("runs a performance audit and reports core web vitals", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "performance" });

    expect(report.category).toBe("performance");
    expect(report.metrics).toBeDefined();
    // Whatever else varies, LCP and FCP are always measured for a real page.
    expect(Object.keys(report.metrics!)).toEqual(
      expect.arrayContaining(["first-contentful-paint", "largest-contentful-paint"])
    );
    expect(report.metrics!["largest-contentful-paint"]!.value).toBeGreaterThan(0);
  }, 240_000);

  it("runs an SEO audit", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "seo" });
    expect(report.category).toBe("seo");
    expect(report.score).toBeTypeOf("number");
  }, 180_000);

  it("runs a best-practices audit", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "best-practices" });
    expect(report.category).toBe("best-practices");
    expect(report.score).toBeTypeOf("number");
  }, 180_000);

  it("keeps a real report small enough to hand to a model", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "accessibility" });
    // A raw Lighthouse result is megabytes; the whole point of the extractor is
    // that what reaches the agent is not.
    expect(JSON.stringify(report).length).toBeLessThan(150_000);
  }, 180_000);

  it("fails clearly on a URL that cannot be audited", async () => {
    await expect(
      runLighthouseAudit({ url: "chrome://settings", category: "seo" })
    ).rejects.toThrow(AuditError);

    expect(() => assertAuditableUrl("not a url")).toThrow(AuditError);
    expect(() => assertAuditableUrl("file:///etc/passwd")).toThrow(AuditError);
  }, 60_000);

  /**
   * A stale CHROME_PATH — a browser since uninstalled, a path from another
   * machine — should not cost you every audit when a perfectly good browser is
   * installed. The connector warns and carries on. The case where nothing at
   * all can be found is covered in test/unit/find-browser.test.ts, which can
   * simulate an empty machine as this suite cannot.
   */
  it("falls back to an installed browser when CHROME_PATH is stale", async () => {
    const previous = process.env["CHROME_PATH"];
    process.env["CHROME_PATH"] = "/nonexistent/chrome-binary";
    try {
      const report = await runLighthouseAudit({ url: fixture.url, category: "seo" });
      expect(report.category).toBe("seo");
      expect(report.score).toBeTypeOf("number");
    } finally {
      process.env["CHROME_PATH"] = previous;
    }
  }, 180_000);

  /**
   * SSRF regression (CWE-918): the audit browser must not follow a redirect or
   * load a frame into a blocked range. 192.0.2.0/24 is TEST-NET-1 — classed as
   * blocked like 169.254.169.254, but unroutable, so a regression here cannot
   * reach anything real.
   */
  describe("egress policy in a real browser", () => {
    let hostile: http.Server;
    let base: string;

    beforeAll(async () => {
      hostile = http.createServer((req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "http://192.0.2.1/latest/meta-data/" }).end();
          return;
        }
        if (req.url === "/redirect-link-local") {
          res.writeHead(302, { Location: "http://169.254.1.1/latest/meta-data/" }).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<!doctype html><html lang="en"><head><title>frame</title></head><body><h1>outer</h1>' +
            '<iframe src="http://192.0.2.1/" title="internal"></iframe></body></html>'
        );
      });
      await new Promise<void>((r) => hostile.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`;
    });

    afterAll(() => hostile?.close());

    // The error has to name the refused host: that is only known if the
    // request reached the proxy. A looser match would also accept Chrome
    // bypassing the proxy and failing to connect on its own.
    it("refuses a redirect into a blocked range", async () => {
      await expect(runLighthouseAudit({ url: `${base}/redirect`, category: "seo" })).rejects.toThrow(
        /tried to reach 192\.0\.2\.1/
      );
    }, 180_000);

    /**
     * Chrome's implicit proxy-bypass rules cover link-local addresses as well
     * as loopback, and 169.254.0.0/16 is where every cloud metadata service
     * lives. This proves `<-loopback>` disables that bypass in the installed
     * Chrome: the proxy must see, and refuse, the request. 169.254.1.1 is not
     * a metadata address; on a machine where Chrome did go direct, the
     * connection attempt would go nowhere, and this test would fail.
     */
    it("routes link-local requests through the proxy, where they are refused", async () => {
      await expect(
        runLighthouseAudit({ url: `${base}/redirect-link-local`, category: "seo" })
      ).rejects.toThrow(/tried to reach 169\.254\.1\.1/);
    }, 180_000);

    it("audits a dev server by its localhost name through the proxy", async () => {
      // The fixture listens on 127.0.0.1 only, while localhost resolves to ::1
      // as well; the proxy has to try both, as the browser would have.
      const report = await runLighthouseAudit({
        url: `http://localhost:${fixture.port}/`,
        category: "seo",
      });
      expect(report.score).toBeTypeOf("number");
      expect(report.metadata.url).toContain("localhost");
    }, 180_000);

    it("still audits a page whose frame was refused, without loading the frame", async () => {
      let lhr: any;
      const report = await runLighthouseAudit(
        { url: `${base}/`, category: "best-practices" },
        { onRawResult: (raw) => (lhr = raw) }
      );
      expect(report.score).toBeTypeOf("number");
      const requests: Array<{ url: string; statusCode: number }> =
        lhr?.audits?.["network-requests"]?.details?.items ?? [];
      const framed = requests.filter((r) => r.url.startsWith("http://192.0.2.1"));
      for (const r of framed) expect(r.statusCode === 403 || r.statusCode === -1).toBe(true);
    }, 180_000);

    it("refuses a metadata address before launching a browser", async () => {
      await expect(
        runLighthouseAudit({ url: "http://169.254.169.254/latest/meta-data/", category: "seo" })
      ).rejects.toThrow(/link-local|metadata/);
    }, 30_000);
  });
});
