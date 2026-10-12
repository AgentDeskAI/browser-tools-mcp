import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import {
  classifyAddress,
  resolveDestination,
  originOf,
  worstClass,
  isLocalName,
  destinationKey,
  destinationKeyOf,
  vouchKeyOf,
} from "../../src/lighthouse/destination";

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
  // Only loopback on the interfaces, so a test runner that happens to own
  // one of these addresses does not change the answer.
  beforeEach(() => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaces([]));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

function interfaces(addresses: string[]): ReturnType<typeof os.networkInterfaces> {
  const entry = (address: string): os.NetworkInterfaceInfo =>
    address.includes(":")
      ? { address, family: "IPv6", netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", internal: false, cidr: null, scopeid: 0 }
      : { address, family: "IPv4", netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal: false, cidr: null };
  return { lo0: [entry("127.0.0.1"), entry("::1")], en0: addresses.map(entry) };
}

/**
 * A service bound to 0.0.0.0 or :: answers on every address this machine
 * has, not only on 127.0.0.1. A global IPv6 address, or a public IPv4 on a
 * cloud VM, is listed as public, and a page can learn it from the audit's own
 * connection to it, so it has to count as this machine.
 */
describe("this machine's own addresses", () => {
  beforeEach(() => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      interfaces(["2600:4040:a30b:cf00::4345", "192.168.1.201", "203.0.114.7"])
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("are loopback, in any spelling", () => {
    for (const address of [
      "2600:4040:a30b:cf00::4345",
      "2600:4040:a30b:cf00:0:0:0:4345",
      "[2600:4040:a30b:cf00::4345]",
      "203.0.114.7",
      "::ffff:203.0.114.7",
      "::ffff:cb00:7207",
      "192.168.1.201",
    ]) {
      expect(classifyAddress(address), address).toBe("loopback");
    }
  });

  it("leave their neighbours as they were", () => {
    expect(classifyAddress("2600:4040:a30b:cf00::4346")).toBe("public");
    expect(classifyAddress("203.0.114.8")).toBe("public");
    expect(classifyAddress("192.168.1.202")).toBe("private");
  });

  it("make a name that resolves to one loopback too", async () => {
    const dest = await resolveDestination("me.example.com", async () => ["93.184.215.14", "2600:4040:a30b:cf00::4345"]);
    expect(dest.class).toBe("loopback");
  });

  it("are not needed to classify anything else", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses: permission denied");
    });
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
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
    expect(dest.unresolved).toBe(true);
    const empty = await resolveDestination("empty.test", async () => []);
    expect(empty.class).toBe("blocked");
    expect(empty.unresolved).toBe(true);
    // A blocked address or name is blocked for what it is, not for failing to resolve.
    expect((await resolveDestination("metadata.google.internal", async () => [])).unresolved).toBeUndefined();
    expect((await resolveDestination("imds.test", async () => ["169.254.169.254"])).unresolved).toBeUndefined();
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

describe("isLocalName", () => {
  it("accepts names no public DNS owner can repoint", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "[::1]",
      "192.168.1.10",
      "devbox",
      "myapp.test",
      "printer.local",
      "api.internal",
      "nas.home.arpa",
      "router.lan",
      "Router.LAN.",
    ]) {
      expect(isLocalName(host), host).toBe(true);
    }
  });

  it("rejects public DNS names, even ones that point at loopback today", () => {
    for (const host of ["evil.example.com", "lvh.me", "127.0.0.1.nip.io", "localhost.evil.com", "test.com", ""]) {
      expect(isLocalName(host), host).toBe(false);
    }
  });
});

describe("destinationKey", () => {
  it("treats the spellings of localhost as one host, port by port", () => {
    const spellings = ["localhost", "app.localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1"];
    for (const host of spellings) expect(destinationKey(host, 3000), host).toBe("localhost:3000");
    expect(destinationKey("0:0:0:0:0:0:0:1", 3000)).toBe("localhost:3000");
    expect(destinationKey("localhost", 3001)).toBe("localhost:3001");
  });

  it("keeps other loopback addresses apart from localhost", () => {
    // Another bind address: a service on 127.0.0.2:8080 is not the one on 127.0.0.1:8080.
    expect(destinationKey("127.0.0.2", 8080)).toBe("127.0.0.2:8080");
    expect(destinationKey("::ffff:127.0.0.2", 8080)).not.toBe("localhost:8080");
    // Classed loopback, so refused like it, but a connection to these leaves
    // the machine for a NAT64 translator, a 6to4 relay or nowhere: a vouch for
    // localhost:3000 must not cover them.
    const embedded = ["64:ff9b::7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::", "::7f00:1", "[64:ff9b::7f00:1]"];
    for (const host of embedded) {
      expect(classifyAddress(host), host).toBe("loopback");
      expect(destinationKey(host, 3000), host).not.toBe("localhost:3000");
    }
    expect(destinationKey("192.168.1.10", 80)).toBe("192.168.1.10:80");
    // A public name that resolves to loopback is still its own name.
    expect(destinationKey("lvh.me", 3000)).toBe("lvh.me:3000");
  });

  it("derives keys from origins with default ports made explicit", () => {
    expect(destinationKeyOf("http://localhost:3000")).toBe("localhost:3000");
    expect(destinationKeyOf("http://127.0.0.1/")).toBe("localhost:80");
    expect(destinationKeyOf("https://router.lan")).toBe("router.lan:443");
    expect(destinationKeyOf("chrome://settings")).toBeNull();
    expect(destinationKeyOf("not a url")).toBeNull();
  });

  it("compares vouches by scheme as well", () => {
    expect(vouchKeyOf("http://127.0.0.1:3000/x")).toBe(vouchKeyOf("http://localhost:3000"));
    expect(vouchKeyOf("https://localhost:3000")).not.toBe(vouchKeyOf("http://localhost:3000"));
    expect(vouchKeyOf("http://127.0.0.2:3000")).not.toBe(vouchKeyOf("http://localhost:3000"));
    expect(vouchKeyOf("ftp://localhost/")).toBeNull();
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
