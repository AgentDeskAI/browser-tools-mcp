import { createConnector, type Connector, SERVER_SIGNATURE } from "./connector/connector.js";
import {
  HttpConnectorClient,
  InProcessConnectorClient,
  type ConnectorClient,
} from "./mcp/client.js";
import { readSessionFile, writeSessionFile, clearSessionFile } from "./util/session.js";
import { createLogger } from "./util/logger.js";
import { readPackageVersion, type CliOptions } from "./cli.js";

const log = createLogger("runtime");

export interface Runtime {
  client: ConnectorClient;
  connector: Connector | null;
  /** Human-readable description of how telemetry is being reached. */
  description: string;
  degradedReason?: string;
  close(): Promise<void>;
}

/**
 * Every call fails with the same explanation when the connector is unavailable.
 *
 * These reject rather than throwing synchronously: the interface declares
 * promises, and a caller attaching `.catch()` instead of using `await` would
 * otherwise get an uncaught exception.
 */
class UnavailableConnectorClient implements ConnectorClient {
  #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  #fail<T>(): Promise<T> {
    return Promise.reject(
      new Error(
        `The browser connector is not available: ${this.#reason}. ` +
          `Check that nothing else is using the port, then restart your MCP client.`
      )
    );
  }

  console(): Promise<never> {
    return this.#fail();
  }
  network(): Promise<never> {
    return this.#fail();
  }
  selectedElement(): Promise<never> {
    return this.#fail();
  }
  page(): Promise<never> {
    return this.#fail();
  }
  status(): Promise<never> {
    return this.#fail();
  }
  tabs(): Promise<never> {
    return this.#fail();
  }
  wipe(): Promise<never> {
    return this.#fail();
  }
  screenshot(): Promise<never> {
    return this.#fail();
  }
  refresh(): Promise<never> {
    return this.#fail();
  }
  navigate(): Promise<never> {
    return this.#fail();
  }
  listChromeTabs(): Promise<never> {
    return this.#fail();
  }
  readChromeTab(): Promise<never> {
    return this.#fail();
  }
  navigateChromeTab(): Promise<never> {
    return this.#fail();
  }
  softClickChromeTab(): Promise<never> {
    return this.#fail();
  }
  softTypeChromeTab(): Promise<never> {
    return this.#fail();
  }
  storage(): Promise<never> {
    return this.#fail();
  }
  audit(): Promise<never> {
    return this.#fail();
  }
  exportConsole(): Promise<never> {
    return this.#fail();
  }
  exportNetwork(): Promise<never> {
    return this.#fail();
  }
  readArtifact(): Promise<never> {
    return this.#fail();
  }
}

/**
 * Confirms a connector is alive at this address. Bounded to a few hundred
 * milliseconds: this replaces the old startup scan of 3 hosts x 11 ports with
 * a one-second timeout each, which could delay the MCP handshake by half a minute.
 */
async function probe(baseUrl: string, timeoutMs = 400): Promise<boolean> {
  try {
    const response = await fetch(new URL("/.identity", baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const identity = (await response.json()) as { signature?: string };
    return identity.signature === SERVER_SIGNATURE;
  } catch {
    return false;
  }
}

/**
 * Establishes how this process will reach browser telemetry.
 *
 * Preference order: an explicitly requested connector, then one already running
 * for another MCP client, then a freshly embedded one. Starting our own is the
 * normal case and needs no configuration — which is the point, since needing a
 * second process was the single largest source of support load in 1.x.
 */
export async function createRuntime(options: CliOptions): Promise<Runtime> {
  // Audit policy belongs to the connector, so attaching leaves it as the
  // process that started the connector set it. Fails closed, but say so: the
  // refusal message tells the user to pass the very flag they passed. The
  // values may well match the connector's (an environment variable both
  // processes read), so this says where they count, not that they are wrong.
  const warnAuditFlagsIgnored = (where: string) => {
    if (options.auditAllowedOrigins?.length || options.auditAllowPrivateNetwork) {
      log.warn(
        `--audit-allow-origin and --audit-allow-private-network (or their BROWSER_TOOLS_AUDIT_* ` +
          `variables) take effect only in the process that starts the connector. This process is ` +
          `attaching to ${where}, which keeps the audit settings it was started with.`
      );
    }
    if (options.allowEval || options.allowInput || options.allowInputOrigins?.length || options.excludeOrigins?.length) {
      log.warn(
        `--allow-eval, --allow-input, --allow-input-origins, and --exclude-origins take effect only ` +
          `in the process that starts the connector. This process is attaching to ${where}, which ` +
          `keeps the capability settings it was started with.`
      );
    }
  };

  if (options.connectUrl) {
    warnAuditFlagsIgnored(`the connector at ${options.connectUrl}`);
    const token = options.token ?? readSessionFile()?.token ?? "";
    if (!token) {
      throw new Error("--connect requires --token (or a readable session file)");
    }
    return {
      client: new HttpConnectorClient({ baseUrl: options.connectUrl, token }),
      connector: null,
      description: `attached to the connector at ${options.connectUrl}`,
      async close() {
        /* someone else owns that process */
      },
    };
  }

  const existing = readSessionFile();
  if (existing && (await probe(`http://127.0.0.1:${existing.port}`))) {
    log.info(`Attaching to the connector already running on port ${existing.port}`);
    warnAuditFlagsIgnored(`the connector already running on port ${existing.port}`);
    return {
      client: new HttpConnectorClient({
        baseUrl: `http://127.0.0.1:${existing.port}`,
        token: existing.token,
      }),
      connector: null,
      description: `attached to the shared connector on port ${existing.port}`,
      async close() {
        /* started by another process; leave it running */
      },
    };
  }

  try {
    const connector = await createConnector({
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.screenshotDir ? { screenshotDir: options.screenshotDir } : {}),
      ...(options.token ? { token: options.token } : {}),
      redact: options.redact,
      verbose: options.verbose,
      ...(options.auditAllowedOrigins ? { auditAllowedOrigins: options.auditAllowedOrigins } : {}),
      auditAllowPrivateNetwork: options.auditAllowPrivateNetwork,
      allowEval: options.allowEval,
      allowInput: options.allowInput,
      ...(options.allowInputOrigins ? { allowInputOrigins: options.allowInputOrigins } : {}),
      ...(options.excludeOrigins ? { excludeOrigins: options.excludeOrigins } : {}),
      ...(options.enabledTools ? { enabledTools: options.enabledTools } : {}),
      ...(options.disabledTools ? { disabledTools: options.disabledTools } : {}),
      ...(options.extensionId ? { extensionId: options.extensionId } : {}),
    });

    writeSessionFile({
      port: connector.port,
      token: connector.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      // Was a literal that 2.0.1 and 2.0.2 never updated; connector-bin already reads the real one.
      version: readPackageVersion(),
    });

    return {
      client: new InProcessConnectorClient(connector),
      connector,
      description: `embedded connector on port ${connector.port}`,
      async close() {
        clearSessionFile();
        await connector.close();
      },
    };
  } catch (error) {
    // A failure here must not stop the MCP session from starting: the client
    // needs to come up so it can show the user what went wrong.
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`Could not start the local connector: ${reason}`);
    return {
      client: new UnavailableConnectorClient(reason),
      connector: null,
      description: "unavailable",
      degradedReason: reason,
      async close() {
        /* nothing was started */
      },
    };
  }
}
