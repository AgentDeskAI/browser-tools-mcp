import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Details of a running connector, published so that a separately-started MCP
 * process can attach to it without probing the network.
 */
export interface SessionInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  version: string;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function sessionDir(): string {
  return (
    process.env["BROWSER_TOOLS_STATE_DIR"] ??
    path.join(os.homedir(), ".browser-tools-mcp")
  );
}

export function sessionFilePath(): string {
  return path.join(sessionDir(), "session.json");
}

/** Writes the session file with owner-only permissions — it contains a token. */
export function writeSessionFile(info: SessionInfo): void {
  try {
    const dir = sessionDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = sessionFilePath();
    fs.writeFileSync(file, JSON.stringify(info, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (error) {
    logger.warn("Could not write session file:", error);
  }
}

export function readSessionFile(): SessionInfo | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as SessionInfo;
    if (typeof parsed?.port !== "number" || typeof parsed?.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSessionFile(): void {
  try {
    fs.rmSync(sessionFilePath(), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Constant-time comparison so token checks cannot be timed.
 *
 * Both sides are hashed first. A length mismatch used to return before the
 * comparison, which leaks the secret's length; the digests are always the
 * same size.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}
