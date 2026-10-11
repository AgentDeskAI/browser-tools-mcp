import dns from "node:dns";
import net from "node:net";

/**
 * Where an audit is allowed to send the headless browser.
 *
 * Until 2.0.3 the only check on an audit url was its scheme, so an MCP client
 * (or a model steered by prompt injection in page content) could point the
 * audit browser at loopback services, the LAN, or a cloud metadata endpoint,
 * then read the result back through the stored Lighthouse report — which
 * carries a screenshot of the rendered page. See GHSA-fm7v-38h4-4q7w / CWE-918.
 *
 * Every address is put in one of four classes:
 *
 * - "blocked"  never reachable: link-local (cloud metadata lives here),
 *              unspecified, multicast, reserved and documentation ranges,
 *              known metadata addresses and names.
 * - "loopback" this machine.
 * - "private"  RFC 1918, CGNAT, unique-local IPv6 and friends.
 * - "public"   everything else.
 *
 * Loopback and private destinations are not forbidden outright — auditing a
 * dev server on localhost is this tool's main use — but they have to be
 * vouched for. See `connector.ts` (`checkAuditTarget`) for the top-level rule
 * and `egress-proxy.ts` for how subresources and redirects are held to it.
 */
export type AddressClass = "public" | "private" | "loopback" | "blocked";

const SEVERITY: Record<AddressClass, number> = { public: 0, private: 1, loopback: 2, blocked: 3 };

/** The most restrictive of several classes; a host is only as safe as its worst address. */
export function worstClass(classes: AddressClass[]): AddressClass {
  return classes.reduce<AddressClass>(
    (worst, c) => (SEVERITY[c] > SEVERITY[worst] ? c : worst),
    "public"
  );
}

function blockList(v4: string[], v6: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of v4) {
    const [addr, bits] = cidr.split("/");
    list.addSubnet(addr!, Number(bits), "ipv4");
  }
  for (const cidr of v6) {
    const [addr, bits] = cidr.split("/");
    list.addSubnet(addr!, Number(bits), "ipv6");
  }
  return list;
}

const BLOCKED = blockList(
  [
    "0.0.0.0/8", // "this network"; 0.0.0.0 reaches loopback services on Linux/macOS
    "169.254.0.0/16", // link-local: AWS/GCP/Azure/OCI/DO metadata at 169.254.169.254
    "100.100.100.200/32", // Alibaba Cloud metadata (inside CGNAT space)
    "192.0.0.0/24", // IETF protocol assignments
    "192.0.2.0/24", // TEST-NET-1
    "198.51.100.0/24", // TEST-NET-2
    "203.0.113.0/24", // TEST-NET-3
    "224.0.0.0/4", // multicast
    "240.0.0.0/4", // reserved, including 255.255.255.255
  ],
  [
    "::/128", // unspecified
    "fd00:ec2::254/128", // AWS IMDS over IPv6
    "fe80::/10", // link-local
    "ff00::/8", // multicast
    "100::/64", // discard-only
    "2001:db8::/32", // documentation
    "2001::/32", // Teredo: tunnels to an embedded IPv4 we cannot vet
  ]
);

const LOOPBACK = blockList(["127.0.0.0/8"], ["::1/128"]);

const PRIVATE = blockList(
  [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10", // CGNAT, also Tailscale
    // 198.18.0.0/15 is deliberately absent: "fake-ip" proxy setups (Clash,
    // sing-box, Surge) answer every DNS query from that range, and treating it
    // as private would refuse every public site for those users.
  ],
  [
    "fc00::/7", // unique local
    "fec0::/10", // deprecated site-local
  ]
);

/** Host names that never go through DNS to decide. */
const BLOCKED_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data"]);

function isLocalhostName(host: string): boolean {
  // Chrome resolves localhost and every *.localhost name to loopback itself,
  // whatever DNS says, so they must be classified the same way here.
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * What Chrome connects to for a localhost name. Both families, in the order
 * most dev servers are reachable: a server bound to 127.0.0.1 only is common,
 * one bound to ::1 only is rare. The proxy tries each in turn.
 */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"];

/** IPv4 embedded in an IPv6 address by mapping, translation, NAT64, 6to4 or the old compatible form, if any. */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::ffff:0:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;

  const groups = expandIPv6(lower);
  if (!groups) return null;
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // ::ffff:a.b.c.d written in hex, and NAT64 64:ff9b::/96
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return toV4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return toV4(groups[6]!, groups[7]!);
  // IPv4-translated ::ffff:0:a.b.c.d in hex
  if (groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0)
    return toV4(groups[6]!, groups[7]!);
  // Deprecated IPv4-compatible ::a.b.c.d in hex, which is how URL parsing
  // writes it: [::127.0.0.1] becomes [::7f00:1]. :: and ::1 are not IPv4.
  if (groups.slice(0, 6).every((g) => g === 0) && (groups[6] !== 0 || groups[7]! > 1))
    return toV4(groups[6]!, groups[7]!);
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215): the IPv4 address is in the low 32 bits.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return toV4(groups[6]!, groups[7]!);
  // 6to4 2002:AABB:CCDD::/48
  if (groups[0] === 0x2002) return toV4(groups[1]!, groups[2]!);
  return null;
}

function expandIPv6(address: string): number[] | null {
  if (!net.isIPv6(address)) return null;
  let text = address;
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/** Classifies a literal IP address. Anything that is not a valid IP is blocked. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIPv4(bare) ? "ipv4" : net.isIPv6(bare) ? "ipv6" : null;
  if (!family) return "blocked";

  if (family === "ipv6") {
    const v4 = embeddedIPv4(bare);
    if (v4) return worstClass([classifyAddress(v4), classifyV6Only(bare)]);
    return classifyV6Only(bare);
  }
  if (BLOCKED.check(bare, "ipv4")) return "blocked";
  if (LOOPBACK.check(bare, "ipv4")) return "loopback";
  if (PRIVATE.check(bare, "ipv4")) return "private";
  return "public";
}

function classifyV6Only(bare: string): AddressClass {
  if (BLOCKED.check(bare, "ipv6")) return "blocked";
  if (LOOPBACK.check(bare, "ipv6")) return "loopback";
  if (PRIVATE.check(bare, "ipv6")) return "private";
  return "public";
}

export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = async (host) => {
  const results = await dns.promises.lookup(host, { all: true, order: "verbatim" });
  return results.map((r) => r.address);
};

export interface ResolvedDestination {
  host: string;
  /**
   * Every address the host resolved to. The class is the worst of them, so
   * when the class is permitted each address is permitted, and the proxy may
   * connect to any of them (it tries them in order, as a browser would).
   */
  addresses: string[];
  class: AddressClass;
}

/**
 * Resolves a host and classifies it by its worst address.
 *
 * Fails closed: a name that does not resolve is "blocked", so a lookup error
 * can never be the thing that lets a request through.
 */
export async function resolveDestination(
  rawHost: string,
  lookup: Lookup = systemLookup
): Promise<ResolvedDestination> {
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

  if (net.isIP(host)) return { host, addresses: [host], class: classifyAddress(host) };
  if (BLOCKED_NAMES.has(host)) return { host, addresses: [], class: "blocked" };
  // Not asked of DNS at all: Chrome does not ask either, and on many systems
  // *.localhost does not resolve, which would wrongly fail closed on the
  // tool's main use (a dev server on app.localhost:3000, open in a tab).
  if (isLocalhostName(host)) return { host, addresses: [...LOOPBACK_ADDRESSES], class: "loopback" };

  let addresses: string[] = [];
  try {
    addresses = await lookup(host);
  } catch {
    return { host, addresses: [], class: "blocked" };
  }
  if (addresses.length === 0) return { host, addresses, class: "blocked" };

  return { host, addresses, class: worstClass(addresses.map(classifyAddress)) };
}

/** The scheme://host:port an origin check compares, with default ports made explicit. */
export function originOf(url: string | URL): string | null {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}
