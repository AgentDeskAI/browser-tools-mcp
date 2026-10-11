import { describe, it, expect } from "vitest";
import { classifyAddress, resolveDestination, originOf, worstClass } from "../../src/lighthouse/destination";

/**
 * Regression tests for the audit SSRF (CWE-918): the audit browser must not be
 * steerable to metadata endpoints or internal services. Each row is a way an
 * internal address has been smuggled past naive checks elsewhere.
 */
describe("classifyAddress", () => {
  const cases: Array<[string, string]> = [
    ["169.254.169.254", "blocked"], // AWS/GCP/Azure metadata
    ["169.254.170.2", "blocked"], // ECS task metadata
    ["100.100.100.200", "blocked"], // Alibaba metadata
    ["fd00:ec2::254", "blocked"], // AWS IMDS IPv6
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"],
    ["255.255.255.255", "blocked"],
    ["fe80::1", "blocked"],
    ["::", "blocked"],
    ["::ffff:169.254.169.254", "blocked"], // mapped, dotted
    ["::ffff:a9fe:a9fe", "blocked"], // mapped, hex
    ["64:ff9b::a9fe:a9fe", "blocked"], // NAT64
    ["64:ff9b:1::a9fe:a9fe", "blocked"], // local-use NAT64 (RFC 8215)
    ["64:ff9b:1::7f00:1", "loopback"],
    ["2002:a9fe:a9fe::1", "blocked"], // 6to4
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "blocked"], // Teredo
    ["not-an-ip", "blocked"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    // IPv4-compatible and IPv4-translated forms, written in hex the way URL
    // parsing writes them: new URL("http://[::127.0.0.1]/").hostname is [::7f00:1].
    ["::7f00:1", "loopback"],
    ["::a9fe:a9fe", "blocked"],
    ["::a00:1", "private"],
    ["::ffff:0:7f00:1", "loopback"],
    ["::ffff:0:a9fe:a9fe", "blocked"],
    ["::2", "blocked"], // ::0.0.0.2
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["172.32.0.1", "public"],
    ["8.8.8.8", "public"],
    ["93.184.215.14", "public"],
    ["2606:4700::1111", "public"],
    ["198.18.0.1", "public"], // fake-ip proxies; see destination.ts
  ];
  it.each(cases)("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("resolveDestination", () => {
  it("classifies a host by its worst address", async () => {
    const dest = await resolveDestination("mixed.test", async () => ["93.184.215.14", "10.0.0.1"]);
    expect(dest.class).toBe("private");
  });

  it("fails closed when a name does not resolve", async () => {
    const dest = await resolveDestination("nope.test", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(dest.class).toBe("blocked");
    expect((await resolveDestination("empty.test", async () => [])).class).toBe("blocked");
  });

  it("treats localhost and *.localhost as loopback without consulting DNS, as Chrome does", async () => {
    // Also what makes app.localhost auditable where the resolver returns NXDOMAIN for it.
    const asked: string[] = [];
    const lookup = async (host: string) => {
      asked.push(host);
      return ["93.184.215.14"];
    };
    for (const host of ["localhost", "app.localhost", "LOCALHOST.", "a.b.localhost"]) {
      const dest = await resolveDestination(host, lookup);
      expect(dest.class).toBe("loopback");
      expect(dest.addresses).toEqual(["127.0.0.1", "::1"]);
    }
    expect(asked).toEqual([]);
    // Not a localhost name: "localhost.example" or "notlocalhost".
    expect((await resolveDestination("notlocalhost", async () => ["93.184.215.14"])).class).toBe("public");
  });

  it("returns every address so the proxy can try them in order", async () => {
    const dest = await resolveDestination("dual.test", async () => ["::1", "127.0.0.1"]);
    expect(dest.addresses).toEqual(["::1", "127.0.0.1"]);
    expect(dest.class).toBe("loopback");
  });

  it("blocks metadata host names without asking DNS", async () => {
    const dest = await resolveDestination("metadata.google.internal", async () => ["93.184.215.14"]);
    expect(dest.class).toBe("blocked");
  });

  it("classifies URL-normalised IPv4 forms the same as dotted quads", async () => {
    // WHATWG URL parsing (shared by Node and Chrome) turns these into 127.0.0.1.
    for (const raw of ["http://2130706433/", "http://0x7f.1/", "http://127.1/"]) {
      const host = new URL(raw).hostname;
      expect((await resolveDestination(host, async () => [])).class).toBe("loopback");
    }
    const mapped = new URL("http://[::ffff:169.254.169.254]/").hostname;
    expect((await resolveDestination(mapped, async () => [])).class).toBe("blocked");
    for (const [raw, expected] of [
      ["http://[::127.0.0.1]/", "loopback"],
      ["http://[::169.254.169.254]/", "blocked"],
      ["http://[::ffff:0:127.0.0.1]/", "loopback"],
      ["http://[::10.0.0.1]/", "private"],
    ]) {
      const host = new URL(raw!).hostname;
      expect((await resolveDestination(host, async () => [])).class, raw).toBe(expected);
    }
  });
});

describe("originOf", () => {
  it("makes default ports explicit so equivalent origins compare equal", () => {
    expect(originOf("http://localhost/")).toBe("http://localhost:80");
    expect(originOf("http://LOCALHOST:80/x")).toBe("http://localhost:80");
    expect(originOf("https://example.com")).toBe("https://example.com:443");
    expect(originOf("chrome://settings")).toBeNull();
  });

  it("picks the most restrictive class", () => {
    expect(worstClass(["public", "loopback", "private"])).toBe("loopback");
    expect(worstClass([])).toBe("public");
  });
});
