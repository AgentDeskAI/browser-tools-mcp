#!/usr/bin/env node
/**
 * Standalone connector.
 *
 * The MCP server embeds this, so most people never need it. Run it when
 * several MCP clients should share one browser session: start this first, and
 * each client attaches to it instead of starting its own.
 */
import { parseCli, readPackageVersion } from "./cli.js";
import { createConnector } from "./connector/connector.js";
import { clearSessionFile, writeSessionFile } from "./util/session.js";
import { createLogger } from "./util/logger.js";
import { getDefaultScreenshotDir } from "./util/paths.js";

const log = createLogger("connector-bin");

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));

  if (options.showVersion) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (options.showHelp) {
    process.stdout.write(
      `BrowserTools connector\n\n` +
        `Usage:\n  browser-tools-connector [options]\n\n` +
        `Only needed when several MCP clients must share one browser session;\n` +
        `browser-tools-mcp starts its own connector otherwise.\n\n` +
        `Options:\n` +
        `  -v, --version            Print the version and exit\n` +
        `  -h, --help               Print this help and exit\n` +
        `      --port <n>           Port to listen on (default 3025)\n` +
        `      --host <addr>        Loopback address to bind (default 127.0.0.1)\n` +
        `      --screenshot-dir <p> Where screenshots are written\n` +
        `      --verbose            Print each captured entry as it arrives\n` +
        `      --no-redact          Do not scrub credentials from captured data\n` +
        `      --audit-allow-origin <o,o>\n` +
        `                           Loopback/private origins (e.g. http://localhost:3000) that audits\n` +
        `                           may target or load even when no tab is open on them\n` +
        `      --audit-allow-private-network\n` +
        `                           Let audits reach any loopback or private address (not recommended)\n\n` +
        `Audit settings apply to every MCP client that attaches to this connector.\n`
    );
    return;
  }

  const connector = await createConnector({
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.screenshotDir ? { screenshotDir: options.screenshotDir } : {}),
    ...(options.token ? { token: options.token } : {}),
    redact: options.redact,
    verbose: options.verbose,
    ...(options.auditAllowedOrigins ? { auditAllowedOrigins: options.auditAllowedOrigins } : {}),
    auditAllowPrivateNetwork: options.auditAllowPrivateNetwork,
  });

  writeSessionFile({
    port: connector.port,
    token: connector.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: readPackageVersion(),
  });

  // This process has no MCP client on stdout, so it is free to print.
  process.stdout.write(
    `BrowserTools connector listening on http://127.0.0.1:${connector.port}\n` +
      `Screenshots: ${options.screenshotDir ?? getDefaultScreenshotDir()}\n` +
      `Waiting for the Chrome extension. Open Chrome DevTools (F12) on the page you want to inspect.\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    clearSessionFile();
    await connector.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("Fatal error during startup:", error);
  process.exit(1);
});
