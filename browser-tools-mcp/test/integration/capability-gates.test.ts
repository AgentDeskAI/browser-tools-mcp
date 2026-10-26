import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";

import { createConnector, type Connector } from "../../src/connector/connector";
import { GateReason, NO_DEVTOOLS_ACTIONS } from "../../src/gates/capability";
import { FakeExtension } from "../helpers/fake-extension";

let connector: Connector;
let screenshotDir: string;
let worker: FakeExtension | null = null;
let panel: FakeExtension | null = null;
let liveUrl = "http://localhost:3000/";
let probePopup = false;
let probePanel = false;
let probeExclude: string[] = [];

async function start(config: Parameters<typeof createConnector>[0] = {}): Promise<void> {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-gates-"));
  connector = await createConnector({
    port: 0,
    screenshotDir,
    requestTimeoutMs: 2_000,
    heartbeatIntervalMs: 60_000,
    ...config,
  });
}

async function connectWorker(): Promise<void> {
  worker = new FakeExtension({
    port: connector.port,
    role: "worker",
    onCapabilityProbe: (message) => ({
      liveUrl: message.tabId == null ? null : liveUrl,
      popupEnabled: probePopup,
      panelEnabled: probePanel,
      excludeOrigins: probeExclude,
    }),
  });
  await worker.connect();
  await worker.waitForWelcome();
}

async function connectPanel(): Promise<void> {
  panel = new FakeExtension({ port: connector.port, tabId: 7 });
  await panel.connect();
  await panel.waitForWelcome();
}

function probes(): unknown[] {
  return (worker?.received ?? []).filter((message) => message.type === "capability-probe");
}

beforeEach(() => {
  liveUrl = "http://localhost:3000/";
  probePopup = false;
  probePanel = false;
  probeExclude = [];
});

afterEach(async () => {
  await worker?.close();
  await panel?.close();
  worker = null;
  panel = null;
  await connector?.close();
  if (screenshotDir) fs.rmSync(screenshotDir, { recursive: true, force: true });
});

describe("connector capability gate", () => {
  it("refuses each no-DevTools action while the popup switch is off, without probing", async () => {
    await start({ allowInput: true, allowEval: true });
    await connectWorker();

    for (const action of NO_DEVTOOLS_ACTIONS) {
      const decision = await connector.checkCapability(action, {
        tabId: 7,
        destinationUrl: "http://localhost:3000/",
      });
      expect(decision.allowed, action).toBe(false);
      expect(decision.reason, action).toBe(GateReason.popupOff);
    }
    expect(probes()).toEqual([]);
  });

  it("uses the probed live URL, not the URL the tab reported earlier", async () => {
    await start({ allowInput: true });
    await connectPanel();
    panel!.send({ type: "page", url: "http://localhost:3000/app", tabId: 7 });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    liveUrl = "https://example.com/now";

    await expect.poll(async () => (await connector.checkCapability("softClick", { tabId: 7 })).reason).toBe(
      GateReason.urlNotAllowed
    );

    const decision = await connector.checkCapability("softClick", { tabId: 7 });
    expect(decision.allowed).toBe(false);
    expect(decision.liveUrl).toBe("https://example.com/now");
    expect(decision.reason).toBe(GateReason.urlNotAllowed);
  });

  it("allows a local soft click only when the popup, the flag, and the live URL agree", async () => {
    await start({ allowInput: true });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;

    await expect.poll(async () => (await connector.checkCapability("softClick", { tabId: 4 })).allowed).toBe(true);

    probePopup = false;
    expect((await connector.checkCapability("softType", { tabId: 4 })).reason).toBe(GateReason.popupOff);
  });

  it("allows navigate only when both the live tab and the destination are permitted", async () => {
    await start({ allowInput: true, allowInputOrigins: ["https://app.example"] });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    liveUrl = "http://127.0.0.1:3000/home";

    await expect
      .poll(async () => (await connector.checkCapability("navigate", { tabId: 4, destinationUrl: "http://localhost:4000/next" })).allowed)
      .toBe(true);

    expect(
      (await connector.checkCapability("navigate", { tabId: 4, destinationUrl: "https://other.example/" })).reason
    ).toBe(GateReason.destinationNotAllowed);

    liveUrl = "https://app.example/inbox";
    expect(
      (await connector.checkCapability("navigate", { tabId: 4, destinationUrl: "https://app.example/next" })).allowed
    ).toBe(true);
  });

  it("lets an excluded origin win over local and the allowlist", async () => {
    await start({ allowInput: true });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    probeExclude = ["http://localhost:3000"];

    await expect.poll(async () => (await connector.checkCapability("softClick", { tabId: 4 })).reason).toBe(
      GateReason.excluded
    );
  });

  it("keeps real input and script evaluation behind their own switches", async () => {
    await start({ allowInput: true, allowEval: true });
    await connectPanel();
    await connectWorker();
    probePanel = true;
    liveUrl = "http://localhost:3000/";

    expect((await connector.checkCapability("click", { tabId: 7 })).reason).toBe(GateReason.panelOff);
    expect((await connector.checkCapability("evaluateScript", { tabId: 7 })).reason).toBe(GateReason.panelOff);

    panel!.send({ type: "capability-state", panelEnabled: true });
    await expect.poll(async () => (await connector.checkCapability("click", { tabId: 7 })).allowed).toBe(true);
    expect((await connector.checkCapability("evaluateScript", { tabId: 7 })).allowed).toBe(true);
    expect((await connector.checkCapability("debuggerFallback", { tabId: 7, hideBanner: true })).reason).toBe(
      GateReason.banner
    );
  });

  it("refuses input and eval when the process was not started with the flag", async () => {
    await start();
    await connectPanel();
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    panel!.send({ type: "capability-state", panelEnabled: true });
    probePopup = true;
    probePanel = true;

    await expect.poll(async () => (await connector.checkCapability("navigate", { tabId: 7, destinationUrl: "http://localhost:3000/" })).reason).toBe(
      GateReason.inputOff
    );
    expect((await connector.checkCapability("evaluateScript", { tabId: 7 })).reason).toBe(GateReason.evalOff);
    expect((await connector.checkCapability("readTab", { tabId: 7 })).allowed).toBe(true);
  });

  it("ignores a switch report that did not come from the extension", async () => {
    await start({ allowInput: true });
    const socket = new WebSocket(`ws://127.0.0.1:${connector.port}/extension-ws`, {
      headers: { Authorization: `Bearer ${connector.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", role: "worker" }));
    socket.send(JSON.stringify({ type: "capability-state", popupEnabled: true, panelEnabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await connector.checkCapability("listTabs")).reason).toBe(GateReason.popupOff);
    socket.close();
  });

  it("fails closed when an exclude entry is not an http(s) origin", async () => {
    await start({ allowInput: true, excludeOrigins: ["example.com"] });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    expect((await connector.checkCapability("listTabs")).reason).toBe(GateReason.excludeInvalid);
  });

  it("drops the popup switch when the worker disconnects", async () => {
    await start({ allowInput: true });
    await connectWorker();
    worker!.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    await expect.poll(async () => (await connector.checkCapability("listTabs")).allowed).toBe(true);

    await worker!.close();
    worker = null;
    expect((await connector.checkCapability("listTabs")).reason).toBe(GateReason.popupOff);
  });
});
