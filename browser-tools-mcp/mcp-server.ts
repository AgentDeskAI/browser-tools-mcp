#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import fs from "fs";

// Create the MCP server
const server = new McpServer({
  name: "Browser Tools MCP",
  version: "1.1.1",
});

// Track the discovered server connection
let discoveredHost = "127.0.0.1";
let discoveredPort = 3025;
let serverDiscovered = false;

// Function to get the default port from environment variable or default
function getDefaultServerPort(): number {
  // Check environment variable first
  if (process.env.BROWSER_TOOLS_PORT) {
    const envPort = parseInt(process.env.BROWSER_TOOLS_PORT, 10);
    if (!isNaN(envPort) && envPort > 0) {
      return envPort;
    }
  }

  // Try to read from .port file
  try {
    const portFilePath = path.join(__dirname, ".port");
    if (fs.existsSync(portFilePath)) {
      const port = parseInt(fs.readFileSync(portFilePath, "utf8").trim(), 10);
      if (!isNaN(port) && port > 0) {
        return port;
      }
    }
  } catch (err) {
    console.error("Error reading port file:", err);
  }

  // Default port if no configuration found
  return 3025;
}

// Function to get default server host from environment variable or default
function getDefaultServerHost(): string {
  // Check environment variable first
  if (process.env.BROWSER_TOOLS_HOST) {
    return process.env.BROWSER_TOOLS_HOST;
  }

  // Default to localhost
  return "127.0.0.1";
}

// Server discovery function - similar to what you have in the Chrome extension
async function discoverServer(): Promise<boolean> {
  console.log("Starting server discovery process");

  // Common hosts to try
  const hosts = [getDefaultServerHost(), "127.0.0.1", "localhost"];

  // Ports to try (start with default, then try others)
  const defaultPort = getDefaultServerPort();
  const ports = [defaultPort];

  // Add additional ports (fallback range)
  for (let p = 3025; p <= 3035; p++) {
    if (p !== defaultPort) {
      ports.push(p);
    }
  }

  console.log(`Will try hosts: ${hosts.join(", ")}`);
  console.log(`Will try ports: ${ports.join(", ")}`);

  // Try to find the server
  for (const host of hosts) {
    for (const port of ports) {
      try {
        console.log(`Checking ${host}:${port}...`);

        // Use the identity endpoint for validation
        const response = await fetch(`http://${host}:${port}/.identity`, {
          signal: AbortSignal.timeout(1000), // 1 second timeout
        });

        if (response.ok) {
          const identity = await response.json();

          // Verify this is actually our server by checking the signature
          if (identity.signature === "mcp-browser-connector-24x7") {
            console.log(`Successfully found server at ${host}:${port}`);

            // Save the discovered connection
            discoveredHost = host;
            discoveredPort = port;
            serverDiscovered = true;

            return true;
          }
        }
      } catch (error: any) {
        // Ignore connection errors during discovery
        console.error(`Error checking ${host}:${port}: ${error.message}`);
      }
    }
  }

  console.error("No server found during discovery");
  return false;
}

// Wrapper function to ensure server connection before making requests
async function withServerConnection<T>(
  apiCall: () => Promise<T>
): Promise<T | any> {
  // Attempt to discover server if not already discovered
  if (!serverDiscovered) {
    const discovered = await discoverServer();
    if (!discovered) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to discover browser connector server. Please ensure it's running.",
          },
        ],
        isError: true,
      };
    }
  }

  // Now make the actual API call with discovered host/port
  try {
    return await apiCall();
  } catch (error: any) {
    // If the request fails, try rediscovering the server once
    console.error(
      `API call failed: ${error.message}. Attempting rediscovery...`
    );
    serverDiscovered = false;

    if (await discoverServer()) {
      console.error("Rediscovery successful. Retrying API call...");
      try {
        // Retry the API call with the newly discovered connection
        return await apiCall();
      } catch (retryError: any) {
        console.error(`Retry failed: ${retryError.message}`);
        return {
          content: [
            {
              type: "text",
              text: `Error after reconnection attempt: ${retryError.message}`,
            },
          ],
          isError: true,
        };
      }
    } else {
      console.error("Rediscovery failed. Could not reconnect to server.");
      return {
        content: [
          {
            type: "text",
            text: `Failed to reconnect to server: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// We'll define our tools that retrieve data from the browser connector
server.tool("getConsoleLogs", "Check our browser logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/console-logs`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
    };
  });
});

server.tool(
  "getConsoleErrors",
  "Check our browsers console errors",
  async () => {
    return await withServerConnection(async () => {
      const response = await fetch(
        `http://${discoveredHost}:${discoveredPort}/console-errors`
      );
      const json = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(json, null, 2),
          },
        ],
      };
    });
  }
);

server.tool("getNetworkErrors", "Check our network ERROR logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/network-errors`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
      isError: true,
    };
  });
});

server.tool("getNetworkLogs", "Check ALL our network logs", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/network-success`
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
    };
  });
});

server.tool(
  "takeScreenshot",
  "Take a screenshot of the current browser tab",
  async () => {
    return await withServerConnection(async () => {
      try {
        const response = await fetch(
          `http://${discoveredHost}:${discoveredPort}/capture-screenshot`,
          {
            method: "POST",
          }
        );

        const result = await response.json();

        if (response.ok) {
          return {
            content: [
              {
                type: "text",
                text: "Successfully saved screenshot",
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Error taking screenshot: ${result.error}`,
              },
            ],
          };
        }
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to take screenshot: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }
);

server.tool(
  "getSelectedElement",
  "Get the selected element from the browser",
  async () => {
    return await withServerConnection(async () => {
      const response = await fetch(
        `http://${discoveredHost}:${discoveredPort}/selected-element`
      );
      const json = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(json, null, 2),
          },
        ],
      };
    });
  }
);

server.tool("wipeLogs", "Wipe all browser logs from memory", async () => {
  return await withServerConnection(async () => {
    const response = await fetch(
      `http://${discoveredHost}:${discoveredPort}/wipelogs`,
      {
        method: "POST",
      }
    );
    const json = await response.json();
    return {
      content: [
        {
          type: "text",
          text: json.message,
        },
      ],
    };
  });
});

// Start receiving messages on stdio
(async () => {
  try {
    // Attempt initial server discovery
    console.error("Attempting initial server discovery on startup...");
    await discoverServer();
    if (serverDiscovered) {
      console.error(
        `Successfully discovered server at ${discoveredHost}:${discoveredPort}`
      );
    } else {
      console.error(
        "Initial server discovery failed. Will try again when tools are used."
      );
    }

    const transport = new StdioServerTransport();

    // Ensure stdout is only used for JSON messages
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
      // Only allow JSON messages to pass through
      if (typeof chunk === "string" && !chunk.startsWith("{")) {
        return true; // Silently skip non-JSON messages
      }
      return originalStdoutWrite(chunk, encoding, callback);
    };

    await server.connect(transport);
  } catch (error) {
    console.error("Failed to initialize MCP server:", error);
    process.exit(1);
  }
})();
