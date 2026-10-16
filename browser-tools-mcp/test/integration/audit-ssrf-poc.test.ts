import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createConnector, type Connector } from "../../src/connector/connector";

/**
 * The reporter's proof of concept for the audit SSRF (CWE-918), kept as a
 * regression test.
 *
 * Through 2.0.2 this exact request returned 200 with a reportId, the internal
 * server logged a page load plus /favicon.ico from headless Chrome, and the
 * stored Lighthouse result's final-screenshot showed the marker text. Now the
 * request is refused before any browser starts and the internal server never
 * sees a connection.
 *
 * Deliberately uses the real audit runner, not an injected one: a regression
 * here must fail on the server receiving a request, not pass because the
 * runner was a stub. Everything binds 127.0.0.1; nothing external is contacted.
 */
const MARKER = "INTERNAL-SECRET-do-not-exfiltrate";

let internal: http.Server;
let internalUrl: string;
const hits: string[] = [];
let connector: Connector;
let dir: string;

beforeAll(async () => {
  internal = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>INTERNAL-ADMIN</title></head><body><h1>${MARKER}</h1></body></html>`);
  });
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
  const { port } = internal.address() as import("node:net").AddressInfo;
  internalUrl = `http://127.0.0.1:${port}/`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-ssrf-poc-"));
  connector = await createConnector({ port: 0, screenshotDir: dir });
});

afterAll(async () => {
  await connector?.close();
  await new Promise<void>((r) => internal.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function audit(category: string, url: string) {
  // The live server rather than request(app): a throwaway server per request
  // now and then resets the connection under parallel load, and this file
  // makes a lot of requests.
  return request(`http://127.0.0.1:${connector.port}`)
    .post(`/api/audit/${category}`)
    .set("Authorization", `Bearer ${connector.token}`)
    .send({ url });
}

describe("reporter's PoC: auditing an internal-only loopback service", () => {
  it("is refused, and the internal server is never contacted", async () => {
    const res = await audit("performance", internalUrl);

    expect(res.status).toBe(422);
    expect(res.body.reportId).toBeUndefined();
    expect(res.body.error).toMatch(/not open in a connected browser tab/);
    expect(hits).toEqual([]);

    // Nothing was stored that could be read back as browser-tools://audit/{id}.
    const audits = path.join(dir, "audits");
    expect(fs.existsSync(audits) ? fs.readdirSync(audits) : []).toEqual([]);
  });

  it("is refused in every category and spelling of loopback", async () => {
    const { port } = internal.address() as import("node:net").AddressInfo;
    const spellings = [
      internalUrl,
      `http://localhost:${port}/`,
      `http://[::1]:${port}/`,
      `http://2130706433:${port}/`, // decimal 127.0.0.1
      `http://0x7f000001:${port}/`, // hex
      `http://0177.0.0.1:${port}/`, // octal
      `http://127.1:${port}/`, // short form
      `http://[::ffff:127.0.0.1]:${port}/`, // IPv4-mapped IPv6
      `http://[::ffff:7f00:1]:${port}/`,
    ];
    for (const category of ["performance", "accessibility", "seo", "best-practices"]) {
      for (const url of spellings) {
        const res = await audit(category, url);
        expect(res.status, `${category} ${url}`).toBe(422);
      }
    }
    expect(hits).toEqual([]);
  });

  it("never reaches a cloud metadata address, whatever the spelling", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://2852039166/", // decimal 169.254.169.254
      "http://0xa9fea9fe/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[fd00:ec2::254]/",
      "http://100.100.100.200/latest/meta-data/",
      "http://168.63.129.16/machine/?comp=goalstate", // Azure WireServer
      "http://[::ffff:168.63.129.16]/metadata/instance",
      "http://0.0.0.0/",
    ]) {
      const res = await audit("seo", url);
      expect(res.status, url).toBe(422);
      expect(res.body.error, url).toMatch(/link-local|metadata|reserved/);
    }
  });
});
