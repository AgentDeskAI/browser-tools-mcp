import { describe, expect, it } from "vitest";
import {
  CHROMIUM_PDF_VIEWER_ID,
  loadsWithoutScripting,
  RESTRICTED_PAGE_MESSAGE,
  restrictedPage,
  restrictedPageFields,
  restrictedPageFromExtensionError,
  RestrictedPageError,
} from "../../src/restricted-page";

describe("restrictedPage", () => {
  it("classifies the pages an extension cannot script", () => {
    const cases: Array<[string, string]> = [
      ["chrome://settings", "chrome"],
      ["chrome://settings/", "chrome"],
      ["chrome-untrusted://new-tab-page", "chrome"],
      ["chrome-error://chromewebdata/", "chrome"],
      ["devtools://devtools/bundled/inspector.html", "devtools"],
      ["view-source:https://example.com/", "view-source"],
      ["https://chromewebstore.google.com/detail/foo", "web-store"],
      ["https://chrome.google.com/webstore/detail/foo/bar", "web-store"],
      ["https://chrome.google.com/webstore", "web-store"],
      ["http://localhost:3000/files/report.PDF?download=1", "pdf"],
      ["https://example.com/file.pdf#page=2", "pdf"],
      ["http://localhost:3000/path.pdf/", "pdf"],
      [`chrome-extension://${CHROMIUM_PDF_VIEWER_ID}/index.html`, "pdf"],
      ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html", "extension"],
      ["edge://settings", "browser"],
      ["brave://flags", "browser"],
      ["about:config", "browser"],
      ["moz-extension://12345678-1234-1234-1234-123456789abc/page.html", "extension"],
    ];

    for (const [url, kind] of cases) {
      const found = restrictedPage(url);
      expect(found, url).toMatchObject({
        access: "metadata-only",
        message: RESTRICTED_PAGE_MESSAGE,
        scriptable: false,
        kind,
      });
      expect(found?.detail, url).toBeTruthy();
    }

    expect(restrictedPage("chrome-error://chromewebdata/")?.detail).toContain("error page");
  });

  it("leaves ordinary pages and about:blank alone", () => {
    for (const url of [
      "https://example.com/",
      "http://localhost:3000/app",
      "https://chrome.google.com/search",
      "https://www.google.com/webstore",
      "https://example.com/report.pdf.bak",
      "https://example.com/pdf/viewer",
      "about:blank",
      "",
      "not a url",
    ]) {
      expect(restrictedPage(url), url).toBeNull();
      expect(restrictedPageFields(url), url).toEqual({});
    }
  });

  it("only treats an http(s) PDF as a page that can still be opened", () => {
    expect(loadsWithoutScripting("http://127.0.0.1:3000/a.pdf")).toBe(true);
    expect(loadsWithoutScripting("https://example.com/a.pdf")).toBe(true);
    expect(loadsWithoutScripting("chrome://settings")).toBe(false);
    expect(loadsWithoutScripting(`chrome-extension://${CHROMIUM_PDF_VIEWER_ID}/index.html`)).toBe(false);
    expect(loadsWithoutScripting("file:///tmp/a.pdf")).toBe(false);
  });

  it("reads Chrome's own refusal text back into the same report", () => {
    expect(
      restrictedPageFromExtensionError('Cannot access contents of url "devtools://devtools/"')?.kind
    ).toBe("devtools");
    expect(restrictedPageFromExtensionError("Cannot access a chrome:// URL")?.kind).toBe("chrome");
    expect(
      restrictedPageFromExtensionError("The extensions gallery cannot be scripted.")?.kind
    ).toBe("web-store");
    expect(restrictedPageFromExtensionError("The tab was closed")).toBeNull();
  });

  it("puts the shared wording on the error agents see", () => {
    const error = new RestrictedPageError(restrictedPage("chrome://settings")!, {
      navigated: true,
      tabId: 7,
      requestedUrl: "http://localhost:3000/",
      wasDiscarded: false,
    });
    expect(error.message).toContain(RESTRICTED_PAGE_MESSAGE);
    expect(error.toJSON()).toMatchObject({
      access: "metadata-only",
      message: RESTRICTED_PAGE_MESSAGE,
      scriptable: false,
      kind: "chrome",
      navigated: true,
      tabId: 7,
      requestedUrl: "http://localhost:3000/",
      finalUrl: "chrome://settings",
    });
  });
});
