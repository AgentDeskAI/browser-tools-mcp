import { describe, it, expect } from "vitest";
import { parseCli } from "../../src/cli";

describe("audit flags", () => {
  it("are off and empty by default", () => {
    const options = parseCli([], {});
    expect(options.auditAllowPrivateNetwork).toBe(false);
    expect(options.auditAllowedOrigins).toBeUndefined();
  });

  it("read the private-network switch from the environment as true or 1, like the other switches", () => {
    const allows = (value: string) =>
      parseCli([], { BROWSER_TOOLS_AUDIT_ALLOW_PRIVATE_NETWORK: value }).auditAllowPrivateNetwork;
    for (const value of ["true", "1"]) expect(allows(value), value).toBe(true);
    for (const value of ["false", "0", "", "yes"]) expect(allows(value), value).toBe(false);
  });

  it("reads --allow-actions and --extension-id the same way as the other switches", () => {
    expect(parseCli([], {}).allowActions).toBe(false);
    expect(parseCli([], {}).extensionId).toBeUndefined();
    expect(parseCli(["--allow-actions"], {}).allowActions).toBe(true);
    expect(parseCli([], { BROWSER_TOOLS_ALLOW_ACTIONS: "1" }).allowActions).toBe(true);
    expect(parseCli([], { BROWSER_TOOLS_ALLOW_ACTIONS: "yes" }).allowActions).toBe(false);
    expect(parseCli(["--extension-id", "abcdefghijklmnopabcdefghijklmnop"], {}).extensionId).toBe(
      "abcdefghijklmnopabcdefghijklmnop"
    );
    expect(parseCli(["--extension-id=abc"], {}).extensionId).toBe("abc");
  });

  it("collect allowed origins from the environment and every flag spelling", () => {
    const options = parseCli(
      ["--audit-allow-origin", "http://localhost:3000,localhost:4000", "--audit-allow-origin=http://10.0.0.5:8080"],
      { BROWSER_TOOLS_AUDIT_ALLOW_ORIGINS: "http://127.0.0.1:5000" }
    );
    expect(options.auditAllowedOrigins).toEqual([
      "http://127.0.0.1:5000",
      "http://localhost:3000",
      "localhost:4000",
      "http://10.0.0.5:8080",
    ]);
  });
});
