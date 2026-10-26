import net from "node:net";

const MAX_PORT = 65535;

/**
 * Waits until a TCP port is free.
 *
 * The end-to-end files each bind the connector's default port so the extension
 * can discover it, and a browser shutting down can hold its side open briefly
 * after the previous file finished. Without this, the next file's connector
 * silently lands on a different port while the extension still attaches to
 * whatever answers on the default one.
 */
export async function waitForPortFree(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isFree(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Port ${port} was still in use after ${timeoutMs}ms`);
}

/**
 * Holds `count` consecutive loopback ports, starting at `startPort`.
 *
 * The connector treats EADDRINUSE as "try the next port" and gives up only
 * after `count` attempts. Occupying the whole run is what makes "the
 * connector cannot start" true on Windows, where low ports are not reserved
 * for privileged processes.
 */
export async function holdConsecutivePorts(
  count: number
): Promise<{ startPort: number; release: () => Promise<void> }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const first = await listenOn(0);
    const startPort = portOf(first);
    const servers: net.Server[] = [first];

    if (startPort <= 0 || startPort + count - 1 > MAX_PORT) {
      await closeServer(first);
      continue;
    }

    try {
      for (let offset = 1; offset < count; offset++) {
        servers.push(await listenOn(startPort + offset));
      }
      return {
        startPort,
        release: async () => {
          await Promise.all(servers.splice(0).map((server) => closeServer(server)));
        },
      };
    } catch {
      await Promise.all(servers.splice(0).map((server) => closeServer(server)));
    }
  }

  throw new Error(`Could not reserve ${count} consecutive loopback ports`);
}

function portOf(server: net.Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error: Error) => {
      server.close(() => reject(error));
    };
    server.once("error", onError);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    // Closing a socket that never listened reports an error and still calls back.
    server.once("error", () => resolve());
    server.close(() => resolve());
  });
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}
