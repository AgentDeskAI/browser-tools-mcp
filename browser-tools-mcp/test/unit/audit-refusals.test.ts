import { describe, it, expect } from "vitest";
import { describeRefusals } from "../../src/lighthouse/runner";

/**
 * When a page never loads and the egress proxy refused something, the error
 * says what was refused. The proxy cannot tell the document's request from a
 * tracker or the browser's own background traffic, so it must not single one
 * out as the cause.
 */
describe("describeRefusals", () => {
  it("names every refused destination once, with the port for local ones", () => {
    const message = describeRefusals(
      [
        { host: "clients2.google.com", port: 443, class: "blocked" },
        { host: "127.0.0.1", port: 8500, class: "loopback" },
        { host: "127.0.0.1", port: 8500, class: "loopback" },
        { host: "192.0.2.1", port: 80, class: "blocked" },
      ],
      "Lighthouse was unable to reliably load the page you requested. (Status code: 403)"
    );
    expect(message).toBe(
      "The audited page did not load. This audit tried to reach clients2.google.com, 127.0.0.1:8500, " +
        "192.0.2.1, which audits are not allowed to load. (Lighthouse: Lighthouse was unable to " +
        "reliably load the page you requested. (Status code: 403))"
    );
  });

  it("keeps a long list short", () => {
    const refused = Array.from({ length: 13 }, (_, i) => ({
      host: `h${i}.example`,
      port: 443,
      class: "blocked" as const,
    }));
    const message = describeRefusals(refused, undefined);
    expect(message).toContain("h9.example and 3 more, which audits are not allowed to load.");
    expect(message).not.toContain("h10.example");
    expect(message).not.toContain("Lighthouse:");
  });
});
