import { describe, it, expect } from "vitest";
import { describeRefusals } from "../../src/lighthouse/runner";

/**
 * When a page never loads and the egress proxy refused something, the error
 * says what was refused. The proxy cannot tell the document's request from a
 * tracker or the browser's own background traffic, so it must not single one
 * out as the cause.
 */
describe("describeRefusals", () => {
  /**
   * A page refused because its names resolved to the fake-ip range is not
   * forbidden the way a metadata address is: the user is behind a proxy that
   * hides the real destination, and the message has to say what to do about
   * it, so that every audit failing behind such a proxy is not a mystery.
   */
  it("explains a fake-ip answer and names the flag that allows it", () => {
    const message = describeRefusals(
      [
        { host: "www.example.com", port: 443, class: "fake-ip" },
        { host: "cdn.example.net", port: 443, class: "fake-ip" },
        { host: "www.example.com", port: 80, class: "fake-ip" },
      ],
      "Lighthouse was unable to reliably load the page you requested. (Status code: 403)"
    );
    expect(message).toBe(
      "The audited page did not load. www.example.com, cdn.example.net resolved to 198.18.0.0/15, the range " +
        "a fake-IP proxy (Clash, sing-box, Surge in fake-ip mode) answers every name with, so where it " +
        "really goes cannot be checked. Turn fake-ip mode off while auditing, or start the connector with " +
        "--audit-allow-private-network. " +
        "(Lighthouse: Lighthouse was unable to reliably load the page you requested. (Status code: 403))"
    );
    expect(message).not.toMatch(/not allowed to load/);
  });

  it("names every refused destination once, with the port for local ones", () => {
    const message = describeRefusals(
      [
        { host: "clients2.google.com", port: 443, class: "blocked" },
        { host: "127.0.0.1", port: 8500, class: "loopback" },
        { host: "127.0.0.1", port: 8500, class: "loopback" },
        { host: "192.0.2.1", port: 80, class: "blocked" },
        { host: "gone.example", port: 443, class: "blocked", unresolved: true },
      ],
      "Lighthouse was unable to reliably load the page you requested. (Status code: 403)"
    );
    expect(message).toBe(
      "The audited page did not load. This audit tried to reach clients2.google.com, 127.0.0.1:8500, " +
        "192.0.2.1, which audits are not allowed to load. Could not resolve gone.example: check the url, " +
        "or try again if the network was briefly down. " +
        "(Lighthouse: Lighthouse was unable to reliably load the page you requested. (Status code: 403))"
    );
  });

  /**
   * A name that fails to resolve during the audit (a DNS blip, or a page
   * redirecting to a name that does not exist) is not one audits are
   * forbidden to load, and calling it that tells the reader not to retry.
   */
  it("does not call a name that failed to resolve forbidden", () => {
    const message = describeRefusals(
      [{ host: "example.com", port: 443, class: "blocked", unresolved: true }],
      "Lighthouse was unable to reliably load the page you requested. (Status code: 502)"
    );
    expect(message).toBe(
      "The audited page did not load. Could not resolve example.com: check the url, or try again if the " +
        "network was briefly down. (Lighthouse: Lighthouse was unable to reliably load the page you " +
        "requested. (Status code: 502))"
    );
    expect(message).not.toMatch(/not allowed/);
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
