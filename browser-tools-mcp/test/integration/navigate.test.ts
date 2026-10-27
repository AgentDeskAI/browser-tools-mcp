import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { createConnector } from "../../src/connector/connector";
import { GateReason } from "../../src/gates/capability";
import { FakeExtension } from "../helpers/fake-extension";

describe("navigateBrowser", () => {
  let connector: Awaited<ReturnType<typeof createConnector>> | undefined;
  let devtools: FakeExtension | undefined;
  let worker: FakeExtension | undefined;
  let probePopup = false;

  afterEach(async () => {
    await devtools?.close();
    await worker?.close();
    await connector?.close();
    probePopup = false;
  });

  it("navigates when input is allowed and the worker confirms the popup switch", async () => {
    const screenshotDir = path.join(os.tmpdir(), `bt-nav-${Date.now()}`);
    connector = await createConnector({ port: 0, screenshotDir, allowInput: true });
    devtools = new FakeExtension({ port: connector.port, tabId: 7 });
    worker = new FakeExtension({
      port: connector.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/",
        excludeOrigins: [],
      }),
      onNavigate: async (msg) => ({
        ok: true,
        finalUrl: msg.url,
        wasDiscarded: false,
      }),
    });
    await devtools.connect();
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;

    await expect.poll(async () =>
      (await connector.checkCapability("navigate", {
        tabId: 7,
        destinationUrl: "http://127.0.0.1:3000/next",
      })).allowed
    ).toBe(true);

    const result = await connector.navigateTab({
      tabId: 7,
      url: "http://127.0.0.1:3000/next",
    });
    expect(result.finalUrl).toBe("http://127.0.0.1:3000/next");
    expect(result.tabId).toBe(7);
  });

  it("refuses navigation when allowInput is off", async () => {
    const screenshotDir = path.join(os.tmpdir(), `bt-nav-deny-${Date.now()}`);
    connector = await createConnector({ port: 0, screenshotDir, allowInput: false });
    devtools = new FakeExtension({ port: connector.port, tabId: 3 });
    worker = new FakeExtension({
      port: connector.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/",
        excludeOrigins: [],
      }),
    });
    await devtools.connect();
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;

    await expect.poll(async () =>
      (await connector.checkCapability("navigate", {
        tabId: 3,
        destinationUrl: "http://127.0.0.1:3000/next",
      })).reason
    ).toBe(GateReason.inputOff);
  });
});
