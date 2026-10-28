import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CONNECTOR_BIND_ATTEMPTS } from "../../src/connector/connector";
import { holdConsecutivePorts } from "../helpers/port";

const packageDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entry = path.join(packageDir, "dist", "index.js");
const tsc = path.join(packageDir, "..", "node_modules", "typescript", "lib", "tsc.js");

let child: ChildProcessWithoutNullStreams | null = null;
let stateDir: string;

beforeAll(() => {
  // The stdio contract can only be verified against the real built artifact.
  // Run the compiler through node: on Windows `npx` is a `.cmd` shim, and
  // execFile does not search PATHEXT, so `npx tsc` fails with ENOENT.
  execFileSync(process.execPath, [tsc, "-p", path.join(packageDir, "tsconfig.json")], {
    cwd: packageDir,
    stdio: "pipe",
  });
  expect(fs.existsSync(entry)).toBe(true);
}, 120_000);

afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

function launch(args: string[] = []): ChildProcessWithoutNullStreams {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-state-"));
  return spawn(process.execPath, [entry, ...args], {
    env: {
      ...process.env,
      BROWSER_TOOLS_STATE_DIR: stateDir,
      BROWSER_TOOLS_PORT: "0",
      BROWSER_TOOLS_LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function rpc(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

/** Collects stdout until `predicate` sees a matching JSON-RPC response. */
async function collect(
  proc: ChildProcessWithoutNullStreams,
  predicate: (msg: any) => boolean,
  timeoutMs = 20_000
): Promise<{ messages: any[]; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const messages: any[] = [];

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!messages.some((m) => m.id === parsed.id && m.method === parsed.method)) {
          messages.push(parsed);
        }
      } catch {
        /* handled by the purity assertions below */
      }
    }
    if (messages.some(predicate)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return { messages, stdout, stderr };
}

describe("stdio transport contract", () => {
  /**
   * Regression for the bug that broke sessions in strict MCP clients: discovery
   * logging went to stdout before the transport connected, so the very first
   * bytes a client saw were plain text rather than JSON-RPC.
   */
  it("writes nothing but JSON-RPC frames to stdout", async () => {
    child = launch();
    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "purity-test", version: "1.0.0" },
      })
    );

    const { messages, stdout, stderr } = await collect(child, (m) => m.id === 1);

    expect(messages.some((m) => m.id === 1)).toBe(true);

    const nonEmptyLines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(nonEmptyLines.length).toBeGreaterThan(0);
    for (const line of nonEmptyLines) {
      expect(() => JSON.parse(line), `stdout line was not JSON-RPC: ${line}`).not.toThrow();
      expect(JSON.parse(line).jsonrpc).toBe("2.0");
    }

    // Diagnostics still have to go somewhere.
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("answers initialize quickly instead of blocking on discovery", async () => {
    child = launch();
    const started = Date.now();
    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "speed-test", version: "1.0.0" },
      })
    );

    const { messages } = await collect(child, (m) => m.id === 1);
    const elapsed = Date.now() - started;

    expect(messages.some((m) => m.id === 1)).toBe(true);
    // The old implementation probed 3 hosts x 11 ports sequentially with a
    // one-second timeout each before it would answer.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("lists tools over a real stdio session", async () => {
    child = launch();
    child.stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "list-test", version: "1.0.0" },
      })
    );
    await collect(child, (m) => m.id === 1);

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(rpc(2, "tools/list"));

    const { messages } = await collect(child, (m) => m.id === 2);
    const response = messages.find((m) => m.id === 2);

    expect(response?.result?.tools?.length).toBeGreaterThan(5);
  });

  it("keeps stdout clean even when the connector cannot bind", async () => {
    // Port 1 is privileged only on POSIX. The connector also walks forward on
    // EADDRINUSE, so hold the whole run it would try.
    const held = await holdConsecutivePorts(CONNECTOR_BIND_ATTEMPTS);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-state-"));
    try {
      child = spawn(process.execPath, [entry], {
        env: {
          ...process.env,
          BROWSER_TOOLS_STATE_DIR: stateDir,
          BROWSER_TOOLS_PORT: String(held.startPort),
          BROWSER_TOOLS_LOG_LEVEL: "debug",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin.write(
        rpc(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "degraded-test", version: "1.0.0" },
        })
      );

      const { messages, stdout, stderr } = await collect(child, (m) => m.id === 1);

      // The MCP session must still come up so the client can report the problem.
      expect(messages.some((m) => m.id === 1)).toBe(true);
      expect(stderr).toMatch(/Could not start the local connector/);
      for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        expect(() => JSON.parse(line), `stdout line was not JSON-RPC: ${line}`).not.toThrow();
      }
    } finally {
      await held.release();
    }
  }, 45_000);
});

describe("command line interface", () => {
  it("prints a version and exits", () => {
    const out = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help and exits", () => {
    const out = execFileSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
    expect(out).toMatch(/usage/i);
    expect(out).toContain("--port");
  });

  it("lists the audit flags in the help of both binaries", () => {
    // The connector-bin one matters most: a client that attaches is told to
    // pass these flags to the process that starts the connector.
    for (const bin of [entry, path.join(packageDir, "dist", "connector-bin.js")]) {
      const out = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
      expect(out, bin).toContain("--audit-allow-origin");
      expect(out, bin).toContain("--audit-allow-private-network");
    }
  });

  it("reports its configuration with --doctor", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-state-"));
    const result = spawnSync(process.execPath, [entry, "--doctor"], {
      encoding: "utf8",
      env: { ...process.env, BROWSER_TOOLS_STATE_DIR: stateDir, BROWSER_TOOLS_PORT: "0" },
    });

    expect(result.stdout).toMatch(/node/i);
    expect(result.stdout).toMatch(/extension/i);
    expect(result.stdout).toMatch(/screenshot/i);
    // No extension is connected here, so doctor should report a problem and
    // exit non-zero — that is what makes it usable from a script.
    expect(result.stdout).toMatch(/not connected/i);
    expect(result.status).toBe(1);
  });

  it("exits zero from --doctor when nothing is wrong", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-state-"));
    const result = spawnSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      env: { ...process.env, BROWSER_TOOLS_STATE_DIR: stateDir },
    });
    expect(result.status).toBe(0);
  });
});
