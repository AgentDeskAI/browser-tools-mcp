#!/usr/bin/env node

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { tokenizeAndEstimateCost } from "llm-cost";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { IncomingMessage } from "http";
import { Socket } from "net";
import os from "os";

/**
 * Converts a file path to the appropriate format for the current platform
 * Handles Windows, WSL, macOS and Linux path formats
 *
 * @param inputPath - The path to convert
 * @returns The converted path appropriate for the current platform
 */
function convertPathForCurrentPlatform(inputPath: string): string {
  const platform = os.platform();

  // If no path provided, return as is
  if (!inputPath) return inputPath;

  console.log(`Converting path "${inputPath}" for platform: ${platform}`);

  // Windows-specific conversion
  if (platform === "win32") {
    // Convert forward slashes to backslashes
    return inputPath.replace(/\//g, "\\");
  }

  // Linux/Mac-specific conversion
  if (platform === "linux" || platform === "darwin") {
    // Check if this is a Windows UNC path (starts with \\)
    if (inputPath.startsWith("\\\\") || inputPath.includes("\\")) {
      // Check if this is a WSL path (contains wsl.localhost or wsl$)
      if (inputPath.includes("wsl.localhost") || inputPath.includes("wsl$")) {
        // Extract the path after the distribution name
        // Handle both \\wsl.localhost\Ubuntu\path and \\wsl$\Ubuntu\path formats
        const parts = inputPath.split("\\").filter((part) => part.length > 0);
        console.log("Path parts:", parts);

        // Find the index after the distribution name
        const distNames = [
          "Ubuntu",
          "Debian",
          "kali",
          "openSUSE",
          "SLES",
          "Fedora",
        ];

        // Find the distribution name in the path
        let distIndex = -1;
        for (const dist of distNames) {
          const index = parts.findIndex(
            (part) => part === dist || part.toLowerCase() === dist.toLowerCase()
          );
          if (index !== -1) {
            distIndex = index;
            break;
          }
        }

        if (distIndex !== -1 && distIndex + 1 < parts.length) {
          // Reconstruct the path as a native Linux path
          const linuxPath = "/" + parts.slice(distIndex + 1).join("/");
          console.log(
            `Converted Windows WSL path "${inputPath}" to Linux path "${linuxPath}"`
          );
          return linuxPath;
        }

        // If we couldn't find a distribution name but it's clearly a WSL path,
        // try to extract everything after wsl.localhost or wsl$
        const wslIndex = parts.findIndex(
          (part) =>
            part === "wsl.localhost" ||
            part === "wsl$" ||
            part.toLowerCase() === "wsl.localhost" ||
            part.toLowerCase() === "wsl$"
        );

        if (wslIndex !== -1 && wslIndex + 2 < parts.length) {
          // Skip the WSL prefix and distribution name
          const linuxPath = "/" + parts.slice(wslIndex + 2).join("/");
          console.log(
            `Converted Windows WSL path "${inputPath}" to Linux path "${linuxPath}"`
          );
          return linuxPath;
        }
      }

      // For non-WSL Windows paths, just normalize the slashes
      const normalizedPath = inputPath
        .replace(/\\\\/g, "/")
        .replace(/\\/g, "/");
      console.log(
        `Converted Windows UNC path "${inputPath}" to "${normalizedPath}"`
      );
      return normalizedPath;
    }

    // Handle Windows drive letters (e.g., C:\path\to\file)
    if (/^[A-Z]:\\/i.test(inputPath)) {
      // Convert Windows drive path to Linux/Mac compatible path
      const normalizedPath = inputPath
        .replace(/^[A-Z]:\\/i, "/")
        .replace(/\\/g, "/");
      console.log(
        `Converted Windows drive path "${inputPath}" to "${normalizedPath}"`
      );
      return normalizedPath;
    }
  }

  // Return the original path if no conversion was needed or possible
  return inputPath;
}

// Function to get default downloads folder
function getDefaultDownloadsFolder(): string {
  const homeDir = os.homedir();
  // Downloads folder is typically the same path on Windows, macOS, and Linux
  const downloadsPath = path.join(homeDir, "Downloads", "mcp-screenshots");
  return downloadsPath;
}

// We store logs in memory
const consoleLogs: any[] = [];
const consoleErrors: any[] = [];
const networkErrors: any[] = [];
const networkSuccess: any[] = [];
const allXhr: any[] = [];

// Add settings state
let currentSettings = {
  logLimit: 50,
  queryLimit: 30000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  model: "claude-3-sonnet",
  stringSizeLimit: 500,
  maxLogSize: 20000,
  screenshotPath: getDefaultDownloadsFolder(),
  // Add server host configuration
  serverHost: process.env.SERVER_HOST || "0.0.0.0", // Default to all interfaces
};

// Add new storage for selected element
let selectedElement: any = null;

// Add new state for tracking screenshot requests
interface ScreenshotCallback {
  resolve: (value: { data: string; path?: string }) => void;
  reject: (reason: Error) => void;
}

const screenshotCallbacks = new Map<string, ScreenshotCallback>();

// Function to get available port starting with the given port
async function getAvailablePort(
  startPort: number,
  maxAttempts: number = 10
): Promise<number> {
  let currentPort = startPort;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      // Try to create a server on the current port
      // We'll use a raw Node.js net server for just testing port availability
      await new Promise<void>((resolve, reject) => {
        const testServer = require("net").createServer();

        // Handle errors (e.g., port in use)
        testServer.once("error", (err: any) => {
          if (err.code === "EADDRINUSE") {
            console.log(`Port ${currentPort} is in use, trying next port...`);
            currentPort++;
            attempts++;
            resolve(); // Continue to next iteration
          } else {
            reject(err); // Different error, propagate it
          }
        });

        // If we can listen, the port is available
        testServer.once("listening", () => {
          // Make sure to close the server to release the port
          testServer.close(() => {
            console.log(`Found available port: ${currentPort}`);
            resolve();
          });
        });

        // Try to listen on the current port
        testServer.listen(currentPort, currentSettings.serverHost);
      });

      // If we reach here without incrementing the port, it means the port is available
      return currentPort;
    } catch (error: any) {
      console.error(`Error checking port ${currentPort}:`, error);
      // For non-EADDRINUSE errors, try the next port
      currentPort++;
      attempts++;
    }
  }

  // If we've exhausted all attempts, throw an error
  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts starting from ${startPort}`
  );
}

// Start with requested port and find an available one
const REQUESTED_PORT = parseInt(process.env.PORT || "3025", 10);
let PORT = REQUESTED_PORT;

// Create application and initialize middleware
const app = express();
app.use(cors());
// Increase JSON body parser limit to 50MB to handle large screenshots
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Helper to recursively truncate strings in any data structure
function truncateStringsInData(data: any, maxLength: number): any {
  if (typeof data === "string") {
    return data.length > maxLength
      ? data.substring(0, maxLength) + "... (truncated)"
      : data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => truncateStringsInData(item, maxLength));
  }

  if (typeof data === "object" && data !== null) {
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = truncateStringsInData(value, maxLength);
    }
    return result;
  }

  return data;
}

// Helper to safely parse and process JSON strings
function processJsonString(jsonString: string, maxLength: number): string {
  try {
    // Try to parse the string as JSON
    const parsed = JSON.parse(jsonString);
    // Process any strings within the parsed JSON
    const processed = truncateStringsInData(parsed, maxLength);
    // Stringify the processed data
    return JSON.stringify(processed);
  } catch (e) {
    // If it's not valid JSON, treat it as a regular string
    return truncateStringsInData(jsonString, maxLength);
  }
}

// Helper to process logs based on settings
function processLogsWithSettings(logs: any[]) {
  return logs.map((log) => {
    const processedLog = { ...log };

    if (log.type === "network-request") {
      // Handle headers visibility
      if (!currentSettings.showRequestHeaders) {
        delete processedLog.requestHeaders;
      }
      if (!currentSettings.showResponseHeaders) {
        delete processedLog.responseHeaders;
      }
    }

    return processedLog;
  });
}

// Helper to calculate size of a log entry
function calculateLogSize(log: any): number {
  return JSON.stringify(log).length;
}

// Helper to truncate logs based on character limit
function truncateLogsToQueryLimit(logs: any[]): any[] {
  if (logs.length === 0) return logs;

  // First process logs according to current settings
  const processedLogs = processLogsWithSettings(logs);

  let currentSize = 0;
  const result = [];

  for (const log of processedLogs) {
    const logSize = calculateLogSize(log);

    // Check if adding this log would exceed the limit
    if (currentSize + logSize > currentSettings.queryLimit) {
      console.log(
        `Reached query limit (${currentSize}/${currentSettings.queryLimit}), truncating logs`
      );
      break;
    }

    // Add log and update size
    result.push(log);
    currentSize += logSize;
    console.log(`Added log of size ${logSize}, total size now: ${currentSize}`);
  }

  return result;
}

// Endpoint for the extension to POST data
app.post("/extension-log", (req, res) => {
  console.log("\n=== Received Extension Log ===");
  console.log("Request body:", {
    dataType: req.body.data?.type,
    timestamp: req.body.data?.timestamp,
    hasSettings: !!req.body.settings,
  });

  const { data, settings } = req.body;

  // Update settings if provided
  if (settings) {
    console.log("Updating settings:", settings);
    currentSettings = {
      ...currentSettings,
      ...settings,
    };
  }

  if (!data) {
    console.log("Warning: No data received in log request");
    res.status(400).json({ status: "error", message: "No data provided" });
    return;
  }

  console.log(`Processing ${data.type} log entry`);

  switch (data.type) {
    case "console-log":
      console.log("Adding console log:", {
        level: data.level,
        message:
          data.message?.substring(0, 100) +
          (data.message?.length > 100 ? "..." : ""),
        timestamp: data.timestamp,
      });
      consoleLogs.push(data);
      if (consoleLogs.length > currentSettings.logLimit) {
        console.log(
          `Console logs exceeded limit (${currentSettings.logLimit}), removing oldest entry`
        );
        consoleLogs.shift();
      }
      break;
    case "console-error":
      console.log("Adding console error:", {
        level: data.level,
        message:
          data.message?.substring(0, 100) +
          (data.message?.length > 100 ? "..." : ""),
        timestamp: data.timestamp,
      });
      consoleErrors.push(data);
      if (consoleErrors.length > currentSettings.logLimit) {
        console.log(
          `Console errors exceeded limit (${currentSettings.logLimit}), removing oldest entry`
        );
        consoleErrors.shift();
      }
      break;
    case "network-request":
      const logEntry = {
        url: data.url,
        method: data.method,
        status: data.status,
        timestamp: data.timestamp,
      };
      console.log("Adding network request:", logEntry);

      // Route network requests based on status code
      if (data.status >= 400) {
        networkErrors.push(data);
        if (networkErrors.length > currentSettings.logLimit) {
          console.log(
            `Network errors exceeded limit (${currentSettings.logLimit}), removing oldest entry`
          );
          networkErrors.shift();
        }
      } else {
        networkSuccess.push(data);
        if (networkSuccess.length > currentSettings.logLimit) {
          console.log(
            `Network success logs exceeded limit (${currentSettings.logLimit}), removing oldest entry`
          );
          networkSuccess.shift();
        }
      }
      break;
    case "selected-element":
      console.log("Updating selected element:", {
        tagName: data.element?.tagName,
        id: data.element?.id,
        className: data.element?.className,
      });
      selectedElement = data.element;
      break;
    default:
      console.log("Unknown log type:", data.type);
  }

  console.log("Current log counts:", {
    consoleLogs: consoleLogs.length,
    consoleErrors: consoleErrors.length,
    networkErrors: networkErrors.length,
    networkSuccess: networkSuccess.length,
  });
  console.log("=== End Extension Log ===\n");

  res.json({ status: "ok" });
});

// Update GET endpoints to use the new function
app.get("/console-logs", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(consoleLogs);
  res.json(truncatedLogs);
});

app.get("/console-errors", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(consoleErrors);
  res.json(truncatedLogs);
});

app.get("/network-errors", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(networkErrors);
  res.json(truncatedLogs);
});

app.get("/network-success", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(networkSuccess);
  res.json(truncatedLogs);
});

app.get("/all-xhr", (req, res) => {
  // Merge and sort network success and error logs by timestamp
  const mergedLogs = [...networkSuccess, ...networkErrors].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const truncatedLogs = truncateLogsToQueryLimit(mergedLogs);
  res.json(truncatedLogs);
});

// Add new endpoint for selected element
app.post("/selected-element", (req, res) => {
  const { data } = req.body;
  selectedElement = data;
  res.json({ status: "ok" });
});

app.get("/selected-element", (req, res) => {
  res.json(selectedElement || { message: "No element selected" });
});

app.get("/.port", (req, res) => {
  res.send(PORT.toString());
});

// Add new identity endpoint with a unique signature
app.get("/.identity", (req, res) => {
  res.json({
    port: PORT,
    name: "browser-tools-server",
    version: "1.1.0",
    signature: "mcp-browser-connector-24x7",
  });
});

// Add function to clear all logs
function clearAllLogs() {
  console.log("Wiping all logs...");
  consoleLogs.length = 0;
  consoleErrors.length = 0;
  networkErrors.length = 0;
  networkSuccess.length = 0;
  allXhr.length = 0;
  selectedElement = null;
  console.log("All logs have been wiped");
}

// Add endpoint to wipe logs
app.post("/wipelogs", (req, res) => {
  clearAllLogs();
  res.json({ status: "ok", message: "All logs cleared successfully" });
});

interface ScreenshotMessage {
  type: "screenshot-data" | "screenshot-error";
  data?: string;
  path?: string;
  error?: string;
}

export class BrowserConnector {
  private wss: WebSocket.Server;
  private activeConnection: WebSocket | null = null;
  private app: express.Application;
  private server: any;

  constructor(app: express.Application, server: any) {
    this.app = app;
    this.server = server;

    // Initialize WebSocket server using the existing HTTP server
    this.wss = new WebSocket.Server({
      noServer: true,
      path: "/extension-ws",
    });

    // Register the capture-screenshot endpoint
    this.app.post(
      "/capture-screenshot",
      async (req: express.Request, res: express.Response) => {
        console.log(
          "Browser Connector: Received request to /capture-screenshot endpoint"
        );
        console.log("Browser Connector: Request body:", req.body);
        console.log(
          "Browser Connector: Active WebSocket connection:",
          !!this.activeConnection
        );
        await this.captureScreenshot(req, res);
      }
    );

    // Handle upgrade requests for WebSocket
    this.server.on(
      "upgrade",
      (request: IncomingMessage, socket: Socket, head: Buffer) => {
        if (request.url === "/extension-ws") {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit("connection", ws, request);
          });
        }
      }
    );

    this.wss.on("connection", (ws) => {
      console.log("Chrome extension connected via WebSocket");
      this.activeConnection = ws;

      ws.on("message", (message) => {
        try {
          const data = JSON.parse(message.toString());
          // Log message without the base64 data
          console.log("Received WebSocket message:", {
            ...data,
            data: data.data ? "[base64 data]" : undefined,
          });

          // Handle screenshot response
          if (data.type === "screenshot-data" && data.data) {
            console.log("Received screenshot data");
            console.log("Screenshot path from extension:", data.path);
            // Get the most recent callback since we're not using requestId anymore
            const callbacks = Array.from(screenshotCallbacks.values());
            if (callbacks.length > 0) {
              const callback = callbacks[0];
              console.log("Found callback, resolving promise");
              // Pass both the data and path to the resolver
              callback.resolve({ data: data.data, path: data.path });
              screenshotCallbacks.clear(); // Clear all callbacks
            } else {
              console.log("No callbacks found for screenshot");
            }
          }
          // Handle screenshot error
          else if (data.type === "screenshot-error") {
            console.log("Received screenshot error:", data.error);
            const callbacks = Array.from(screenshotCallbacks.values());
            if (callbacks.length > 0) {
              const callback = callbacks[0];
              callback.reject(
                new Error(data.error || "Screenshot capture failed")
              );
              screenshotCallbacks.clear(); // Clear all callbacks
            }
          }
          // Handle cookies data
          else if (data.type === "cookies-data") {
            console.log("Received cookies data from extension");
            // Store the cookies data temporarily
            this.lastCookiesData = data.cookies;
          }
          // Handle localStorage data
          else if (data.type === "local-storage-data") {
            console.log("Received localStorage data from extension");
            // Store the localStorage data temporarily
            this.lastLocalStorageData = data.storage;
          }
          // Handle sessionStorage data
          else if (data.type === "session-storage-data") {
            console.log("Received sessionStorage data from extension");
            // Store the sessionStorage data temporarily
            this.lastSessionStorageData = data.storage;
          } else {
            console.log("Unhandled message type:", data.type);
          }
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
        }
      });

      ws.on("close", () => {
        console.log("Chrome extension disconnected");
        if (this.activeConnection === ws) {
          this.activeConnection = null;
        }
      });
    });

    // Add screenshot endpoint
    this.app.post(
      "/screenshot",
      (req: express.Request, res: express.Response): void => {
        console.log(
          "Browser Connector: Received request to /screenshot endpoint"
        );
        console.log("Browser Connector: Request body:", req.body);
        try {
          console.log("Received screenshot capture request");
          const { data, path: outputPath } = req.body;

          if (!data) {
            console.log("Screenshot request missing data");
            res.status(400).json({ error: "Missing screenshot data" });
            return;
          }

          // Use provided path or default to downloads folder
          const targetPath = outputPath || getDefaultDownloadsFolder();
          console.log(`Using screenshot path: ${targetPath}`);

          // Remove the data:image/png;base64, prefix
          const base64Data = data.replace(/^data:image\/png;base64,/, "");

          // Create the full directory path if it doesn't exist
          fs.mkdirSync(targetPath, { recursive: true });
          console.log(`Created/verified directory: ${targetPath}`);

          // Generate a unique filename using timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = `screenshot-${timestamp}.png`;
          const fullPath = path.join(targetPath, filename);
          console.log(`Saving screenshot to: ${fullPath}`);

          // Write the file
          fs.writeFileSync(fullPath, base64Data, "base64");
          console.log("Screenshot saved successfully");

          res.json({
            path: fullPath,
            filename: filename,
          });
        } catch (error: unknown) {
          console.error("Error saving screenshot:", error);
          if (error instanceof Error) {
            res.status(500).json({ error: error.message });
          } else {
            res.status(500).json({ error: "An unknown error occurred" });
          }
        }
      }
    );

    // Add endpoint for cookies
    this.app.get(
      "/cookies",
      (req: express.Request, res: express.Response): void => {
        console.log("Browser Connector: Received request to /cookies endpoint");

        if (!this.activeConnection) {
          console.log("Browser Connector: No active WebSocket connection to Chrome extension");
          res.status(503).json({ error: "Chrome extension not connected" });
          return;
        }

        // Request cookies data from extension
        this.getCookies()
          .then((cookiesData) => {
            console.log("Browser Connector: Received cookies data from extension");
            res.json(cookiesData);
          })
          .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Browser Connector: Error getting cookies:", errorMessage);
            res.status(500).json({ error: errorMessage });
          });
      }
    );

    // Add endpoint for localStorage
    this.app.get(
      "/local-storage",
      (req: express.Request, res: express.Response): void => {
        console.log("Browser Connector: Received request to /local-storage endpoint");

        if (!this.activeConnection) {
          console.log("Browser Connector: No active WebSocket connection to Chrome extension");
          res.status(503).json({ error: "Chrome extension not connected" });
          return;
        }

        // Request localStorage data from extension
        this.getLocalStorage()
          .then((storageData) => {
            console.log("Browser Connector: Received localStorage data from extension");
            res.json(storageData);
          })
          .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Browser Connector: Error getting localStorage:", errorMessage);
            res.status(500).json({ error: errorMessage });
          });
      }
    );

    // Add endpoint for sessionStorage
    this.app.get(
      "/session-storage",
      (req: express.Request, res: express.Response): void => {
        console.log("Browser Connector: Received request to /session-storage endpoint");

        if (!this.activeConnection) {
          console.log("Browser Connector: No active WebSocket connection to Chrome extension");
          res.status(503).json({ error: "Chrome extension not connected" });
          return;
        }

        // Request sessionStorage data from extension
        this.getSessionStorage()
          .then((storageData) => {
            console.log("Browser Connector: Received sessionStorage data from extension");
            res.json(storageData);
          })
          .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Browser Connector: Error getting sessionStorage:", errorMessage);
            res.status(500).json({ error: errorMessage });
          });
      }
    );
  }

  // Add properties to store the latest data
  private lastCookiesData: any = null;
  private lastLocalStorageData: any = null;
  private lastSessionStorageData: any = null;

  // Add method to get cookies
  private getCookies(): Promise<any> {
    if (!this.activeConnection) {
      throw new Error("Chrome extension not connected");
    }

    // Reset the stored data
    this.lastCookiesData = null;

    // Create a promise that will resolve when we get the cookies data
    const cookiesPromise = new Promise<any>((resolve, reject) => {
      // Set timeout to reject if we don't get a response
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for cookies data from Chrome extension"));
      }, 5000);

      // Set up an interval to check for data
      const checkInterval = setInterval(() => {
        if (this.lastCookiesData) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(this.lastCookiesData);
        }
      }, 100);
    });

    // Send request to extension
    console.log("Browser Connector: Requesting cookies data from extension");
    this.activeConnection.send(JSON.stringify({ type: "get-cookies" }));

    // Wait for data
    return cookiesPromise;
  }

  // Add method to get localStorage
  private getLocalStorage(): Promise<any> {
    if (!this.activeConnection) {
      throw new Error("Chrome extension not connected");
    }

    // Reset the stored data
    this.lastLocalStorageData = null;

    // Create a promise that will resolve when we get the localStorage data
    const storagePromise = new Promise<any>((resolve, reject) => {
      // Set timeout to reject if we don't get a response
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for localStorage data from Chrome extension"));
      }, 5000);

      // Set up an interval to check for data
      const checkInterval = setInterval(() => {
        if (this.lastLocalStorageData) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(this.lastLocalStorageData);
        }
      }, 100);
    });

    // Send request to extension
    console.log("Browser Connector: Requesting localStorage data from extension");
    this.activeConnection.send(JSON.stringify({ type: "get-local-storage" }));

    // Wait for data
    return storagePromise;
  }

  // Add method to get sessionStorage
  private getSessionStorage(): Promise<any> {
    if (!this.activeConnection) {
      throw new Error("Chrome extension not connected");
    }

    // Reset the stored data
    this.lastSessionStorageData = null;

    // Create a promise that will resolve when we get the sessionStorage data
    const storagePromise = new Promise<any>((resolve, reject) => {
      // Set timeout to reject if we don't get a response
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for sessionStorage data from Chrome extension"));
      }, 5000);

      // Set up an interval to check for data
      const checkInterval = setInterval(() => {
        if (this.lastSessionStorageData) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(this.lastSessionStorageData);
        }
      }, 100);
    });

    // Send request to extension
    console.log("Browser Connector: Requesting sessionStorage data from extension");
    this.activeConnection.send(JSON.stringify({ type: "get-session-storage" }));

    // Wait for data
    return storagePromise;
  }

  private async handleScreenshot(req: express.Request, res: express.Response) {
    if (!this.activeConnection) {
      return res.status(503).json({ error: "Chrome extension not connected" });
    }

    try {
      const result = await new Promise((resolve, reject) => {
        // Set up one-time message handler for this screenshot request
        const messageHandler = (message: WebSocket.Data) => {
          try {
            const response: ScreenshotMessage = JSON.parse(message.toString());

            if (response.type === "screenshot-error") {
              reject(new Error(response.error));
              return;
            }

            if (
              response.type === "screenshot-data" &&
              response.data &&
              response.path
            ) {
              // Remove the data:image/png;base64, prefix
              const base64Data = response.data.replace(
                /^data:image\/png;base64,/,
                ""
              );

              // Ensure the directory exists
              const dir = path.dirname(response.path);
              fs.mkdirSync(dir, { recursive: true });

              // Generate a unique filename using timestamp
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const filename = `screenshot-${timestamp}.png`;
              const fullPath = path.join(response.path, filename);

              // Write the file
              fs.writeFileSync(fullPath, base64Data, "base64");
              resolve({
                path: fullPath,
                filename: filename,
              });
            }
          } catch (error) {
            reject(error);
          } finally {
            this.activeConnection?.removeListener("message", messageHandler);
          }
        };

        // Add temporary message handler
        this.activeConnection?.on("message", messageHandler);

        // Request screenshot
        this.activeConnection?.send(
          JSON.stringify({ type: "take-screenshot" })
        );

        // Set timeout
        setTimeout(() => {
          this.activeConnection?.removeListener("message", messageHandler);
          reject(new Error("Screenshot timeout"));
        }, 30000); // 30 second timeout
      });

      res.json(result);
    } catch (error: unknown) {
      if (error instanceof Error) {
        res.status(500).json({ error: error.message });
      } else {
        res.status(500).json({ error: "An unknown error occurred" });
      }
    }
  }

  // Add new endpoint for programmatic screenshot capture
  async captureScreenshot(req: express.Request, res: express.Response) {
    console.log("Browser Connector: Starting captureScreenshot method");
    console.log("Browser Connector: Request headers:", req.headers);
    console.log("Browser Connector: Request method:", req.method);

    if (!this.activeConnection) {
      console.log(
        "Browser Connector: No active WebSocket connection to Chrome extension"
      );
      return res.status(503).json({ error: "Chrome extension not connected" });
    }

    try {
      console.log("Browser Connector: Starting screenshot capture...");
      const requestId = Date.now().toString();
      console.log("Browser Connector: Generated requestId:", requestId);

      // Create promise that will resolve when we get the screenshot data
      const screenshotPromise = new Promise<{ data: string; path?: string }>(
        (resolve, reject) => {
          console.log(
            `Browser Connector: Setting up screenshot callback for requestId: ${requestId}`
          );
          // Store callback in map
          screenshotCallbacks.set(requestId, { resolve, reject });
          console.log(
            "Browser Connector: Current callbacks:",
            Array.from(screenshotCallbacks.keys())
          );

          // Set timeout to clean up if we don't get a response
          setTimeout(() => {
            if (screenshotCallbacks.has(requestId)) {
              console.log(
                `Browser Connector: Screenshot capture timed out for requestId: ${requestId}`
              );
              screenshotCallbacks.delete(requestId);
              reject(
                new Error(
                  "Screenshot capture timed out - no response from Chrome extension"
                )
              );
            }
          }, 10000);
        }
      );

      // Send screenshot request to extension
      const message = JSON.stringify({
        type: "take-screenshot",
        requestId: requestId,
      });
      console.log(
        `Browser Connector: Sending WebSocket message to extension:`,
        message
      );
      this.activeConnection.send(message);

      // Wait for screenshot data
      console.log("Browser Connector: Waiting for screenshot data...");
      const { data: base64Data, path: customPath } = await screenshotPromise;
      console.log("Browser Connector: Received screenshot data, saving...");
      console.log("Browser Connector: Custom path from extension:", customPath);

      // Always prioritize the path from the Chrome extension
      let targetPath = customPath;

      // If no path provided by extension, fall back to defaults
      if (!targetPath) {
        targetPath =
          currentSettings.screenshotPath || getDefaultDownloadsFolder();
      }

      // Convert the path for the current platform
      targetPath = convertPathForCurrentPlatform(targetPath);

      console.log(`Browser Connector: Using path: ${targetPath}`);

      if (!base64Data) {
        throw new Error("No screenshot data received from Chrome extension");
      }

      try {
        fs.mkdirSync(targetPath, { recursive: true });
        console.log(`Browser Connector: Created directory: ${targetPath}`);
      } catch (err) {
        console.error(
          `Browser Connector: Error creating directory: ${targetPath}`,
          err
        );
        throw new Error(
          `Failed to create screenshot directory: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `screenshot-${timestamp}.png`;
      const fullPath = path.join(targetPath, filename);
      console.log(`Browser Connector: Full screenshot path: ${fullPath}`);

      // Remove the data:image/png;base64, prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/png;base64,/, "");

      // Save the file
      try {
        fs.writeFileSync(fullPath, cleanBase64, "base64");
        console.log(`Browser Connector: Screenshot saved to: ${fullPath}`);
      } catch (err) {
        console.error(
          `Browser Connector: Error saving screenshot to: ${fullPath}`,
          err
        );
        throw new Error(
          `Failed to save screenshot: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      res.json({
        path: fullPath,
        filename: filename,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        "Browser Connector: Error capturing screenshot:",
        errorMessage
      );
      res.status(500).json({
        error: errorMessage,
      });
    }
  }
}

// Use an async IIFE to allow for async/await in the initial setup
(async () => {
  try {
    console.log(`Starting Browser Tools Server...`);
    console.log(`Requested port: ${REQUESTED_PORT}`);

    // Find an available port
    try {
      PORT = await getAvailablePort(REQUESTED_PORT);

      if (PORT !== REQUESTED_PORT) {
        console.log(`\n====================================`);
        console.log(`NOTICE: Requested port ${REQUESTED_PORT} was in use.`);
        console.log(`Using port ${PORT} instead.`);
        console.log(`====================================\n`);
      }
    } catch (portError) {
      console.error(`Failed to find an available port:`, portError);
      process.exit(1);
    }

    // Create the server with the available port
    const server = app.listen(PORT, currentSettings.serverHost, () => {
      console.log(`\n=== Browser Tools Server Started ===`);
      console.log(
        `Aggregator listening on http://${currentSettings.serverHost}:${PORT}`
      );

      if (PORT !== REQUESTED_PORT) {
        console.log(
          `NOTE: Using fallback port ${PORT} instead of requested port ${REQUESTED_PORT}`
        );
      }

      // Log all available network interfaces for easier discovery
      const networkInterfaces = os.networkInterfaces();
      console.log("\nAvailable on the following network addresses:");

      Object.keys(networkInterfaces).forEach((interfaceName) => {
        const interfaces = networkInterfaces[interfaceName];
        if (interfaces) {
          interfaces.forEach((iface) => {
            if (!iface.internal && iface.family === "IPv4") {
              console.log(`  - http://${iface.address}:${PORT}`);
            }
          });
        }
      });

      console.log(`\nFor local access use: http://localhost:${PORT}`);
    });

    // Handle server startup errors
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `ERROR: Port ${PORT} is still in use, despite our checks!`
        );
        console.error(
          `This might indicate another process started using this port after our check.`
        );
      } else {
        console.error(`Server error:`, err);
      }
      process.exit(1);
    });

    // Initialize the browser connector with the existing app AND server
    const browserConnector = new BrowserConnector(app, server);

    // Handle shutdown gracefully
    process.on("SIGINT", () => {
      server.close(() => {
        console.log("Server shut down");
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})().catch((err) => {
  console.error("Unhandled error during server startup:", err);
  process.exit(1);
});
