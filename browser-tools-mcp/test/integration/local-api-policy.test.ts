import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createConnector, type Connector } from "../../src/connector/connector";
import {
  EXAMPLE_CHROME_EXTENSION_ORIGIN,
  EXAMPLE_FIREFOX_EXTENSION_ORIGIN,
} from "../../src/connector/security";
import { FakeExtension, tryWebSocket } from "../helpers/fake-extension";

/**
 * `--only` / `--exclude` and the confirmation gate on the local HTTP API.
 * The in-process MCP client does not go through these routes.
 */

const authOf = (connector: Connector) => ({ Authorization: `Bearer ${connector.token}` });

describe("tool filtering on the local API", () => {
  let connector: Connector;

  beforeAll(async () => {
    connector = await createConnector({
      port: 0,
      allowInput: true,
      enabledTools: ["getConsoleLogs", "getPageInfo", "wipeLogs", "runPerformanceAudit"],
      disabledTools: ["wipeLogs"],
      auditLookup: async () => ["93.184.215.14"],
      auditRunner: async ({ category }) =>
        ({ category, score: 1, metadata: {}, summary: {}, issues: [] }) as never,
    });
  });

  afterAll(async () => {
    await connector?.close();
  });

  it("serves an enabled read and refuses one outside --only", async () => {
    const logs = await request(connector.app).get("/api/console").set(authOf(connector));
    expect(logs.status).toBe(200);

    const network = await request(connector.app).get("/api/network").set(authOf(connector));
    expect(network.status).toBe(403);
    expect(network.body.code).toBe("TOOL_DISABLED");

    const errors = await request(connector.app)
      .get("/api/console?errorsOnly=true")
      .set(authOf(connector));
    expect(errors.status).toBe(403);
    expect(errors.body.code).toBe("TOOL_DISABLED");
  });

  it("lets --exclude win over --only, even when actions are allowed", async () => {
    const wipe = await request(connector.app).post("/api/wipe").set(authOf(connector)).send({});
    expect(wipe.status).toBe(403);
    expect(wipe.body.code).toBe("TOOL_DISABLED");
  });

  it("filters audit calls and the export that backs a hidden tool", async () => {
    const performance = await request(connector.app)
      .post("/api/audit/performance")
      .set(authOf(connector))
      .send({ url: "https://example.com/" });
    expect(performance.status).toBe(200);

    const seo = await request(connector.app)
      .post("/api/audit/seo")
      .set(authOf(connector))
      .send({ url: "https://example.com/" });
    expect(seo.status).toBe(403);
    expect(seo.body.code).toBe("TOOL_DISABLED");

    const history = await request(connector.app).get("/api/export/network").set(authOf(connector));
    expect(history.status).toBe(403);
    expect(history.body.code).toBe("TOOL_DISABLED");
  });
});

describe("confirmation gate on state-changing local API calls", () => {
  let connector: Connector;

  beforeAll(async () => {
    connector = await createConnector({ port: 0 });
  });

  afterAll(async () => {
    await connector?.close();
  });

  it("refuses until the panel confirms, and withdraws that when the panel disconnects", async () => {
    const auth = authOf(connector);
    const refused = await request(connector.app).post("/api/wipe").set(auth).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ACTION_NOT_CONFIRMED");

    const read = await request(connector.app).get("/api/console").set(auth);
    expect(read.status).toBe(200);

    const ext = new FakeExtension({ port: connector.port });
    await ext.connect();
    await ext.waitForWelcome();
    ext.send({ type: "capability-state", panelEnabled: true, popupEnabled: false, excludeOrigins: [] });

    await vi.waitFor(async () => {
      const allowed = await request(connector.app).post("/api/wipe").set(auth).send({});
      expect(allowed.status).toBe(200);
    });

    await ext.close();
    await vi.waitFor(async () => {
      const again = await request(connector.app).post("/api/settings").set(auth).send({ logLimit: 20 });
      expect(again.status).toBe(403);
      expect(again.body.code).toBe("ACTION_NOT_CONFIRMED");
    });
  });

  it("allows those calls when the connector was started with --allow-actions", async () => {
    const open = await createConnector({ port: 0, allowInput: true });
    try {
      const res = await request(open.app)
        .post("/api/tabs/select")
        .set(authOf(open))
        .send({ tabId: 1 });
      // No such tab is a 4xx from the handler, not the gate.
      expect(res.body.code).not.toBe("ACTION_NOT_CONFIRMED");
      expect(res.status).not.toBe(403);
    } finally {
      await open.close();
    }
  });
});

describe("extension id", () => {
  it("pairs and accepts a socket only from the named extension", async () => {
    const connector = await createConnector({
      port: 0,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
    });
    try {
      const other = await request(connector.app)
        .post("/.pair")
        .set("Origin", EXAMPLE_FIREFOX_EXTENSION_ORIGIN);
      expect(other.status).toBe(403);

      const mine = await request(connector.app)
        .post("/.pair")
        .set("Origin", EXAMPLE_CHROME_EXTENSION_ORIGIN);
      expect(mine.status).toBe(200);
      expect(mine.body.token).toBe(connector.token);

      const bearer = { Authorization: `Bearer ${connector.token}` };
      const rejected = await tryWebSocket(`ws://127.0.0.1:${connector.port}/extension-ws`, {
        origin: EXAMPLE_FIREFOX_EXTENSION_ORIGIN,
        headers: bearer,
      });
      expect(rejected.accepted).toBe(false);

      const accepted = await tryWebSocket(`ws://127.0.0.1:${connector.port}/extension-ws`, {
        origin: EXAMPLE_CHROME_EXTENSION_ORIGIN,
        headers: bearer,
      });
      expect(accepted.accepted).toBe(true);
    } finally {
      await connector.close();
    }
  });
});
