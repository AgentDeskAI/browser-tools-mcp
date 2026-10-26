import { describe, it, expect } from "vitest";
import {
  EXAMPLE_CHROME_EXTENSION_ORIGIN,
  EXAMPLE_FIREFOX_EXTENSION_ORIGIN,
  EXAMPLE_SAFARI_EXTENSION_ORIGIN,
  extensionOriginAllowed,
  isExtensionOrigin,
} from "../../src/connector/security";
import { tokensMatch } from "../../src/util/session";

describe("extension origins", () => {
  it("accepts the three browser schemes and rejects everything looser", () => {
    expect(isExtensionOrigin(EXAMPLE_CHROME_EXTENSION_ORIGIN)).toBe(true);
    expect(isExtensionOrigin(EXAMPLE_FIREFOX_EXTENSION_ORIGIN)).toBe(true);
    expect(isExtensionOrigin(EXAMPLE_SAFARI_EXTENSION_ORIGIN)).toBe(true);
    expect(isExtensionOrigin("MOZ-EXTENSION://AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(true);

    for (const origin of [
      "",
      "extension://abcdefghijklmnopabcdefghijklmnop",
      "chrome-extension://abcdefghijklmnop",
      "chrome-extension://qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      `${EXAMPLE_CHROME_EXTENSION_ORIGIN}/panel.html`,
      `${EXAMPLE_CHROME_EXTENSION_ORIGIN}?x=1`,
      "https://evil.example",
      "http://localhost:3000",
      "moz-extension://not-a-uuid",
    ]) {
      expect(isExtensionOrigin(origin), origin).toBe(false);
    }
  });

  it("matches a configured id whether it was given bare or as an origin", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(extensionOriginAllowed(EXAMPLE_CHROME_EXTENSION_ORIGIN, id)).toBe(true);
    expect(extensionOriginAllowed(EXAMPLE_CHROME_EXTENSION_ORIGIN, EXAMPLE_CHROME_EXTENSION_ORIGIN)).toBe(
      true
    );
    expect(extensionOriginAllowed(EXAMPLE_FIREFOX_EXTENSION_ORIGIN, id)).toBe(false);
    expect(extensionOriginAllowed(EXAMPLE_CHROME_EXTENSION_ORIGIN)).toBe(true);
  });
});

describe("tokensMatch", () => {
  it("matches equal strings and rejects different lengths without throwing", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("abc", "abC")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});
