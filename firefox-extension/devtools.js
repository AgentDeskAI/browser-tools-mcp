// devtools.js

// Store settings with defaults
let settings = {
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  screenshotPath: "", // Add new setting for screenshot path
};

// Keep track of debugger state
let isDebuggerAttached = false;
let attachDebuggerRetries = 0;
const currentTabId = browser.devtools.inspectedWindow.tabId;
const MAX_ATTACH_RETRIES = 3;
const ATTACH_RETRY_DELAY = 1000; // 1 second

// Load saved settings on startup
browser.storage.local.get(["browserConnectorSettings"], (result) => {
  if (result.browserConnectorSettings) {
    settings = { ...settings, ...result.browserConnectorSettings };
  }
});

// Listen for settings updates
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SETTINGS_UPDATED") {
    settings = message.settings;
  }
});

// Utility to recursively truncate strings in any data structure
function truncateStringsInData(data, maxLength, depth = 0, path = "") {
  // Add depth limit to prevent circular references
  if (depth > 100) {
    console.warn("Max depth exceeded at path:", path);
    return "[MAX_DEPTH_EXCEEDED]";
  }

  console.log(`Processing at path: ${path}, type:`, typeof data);

  if (typeof data === "string") {
    if (data.length > maxLength) {
      console.log(
        `Truncating string at path ${path} from ${data.length} to ${maxLength}`
      );
      return data.substring(0, maxLength) + "... (truncated)";
    }
    return data;
  }

  if (Array.isArray(data)) {
    console.log(`Processing array at path ${path} with length:`, data.length);
    return data.map((item, index) =>
      truncateStringsInData(item, maxLength, depth + 1, `${path}[${index}]`)
    );
  }

  if (typeof data === "object" && data !== null) {
    console.log(
      `Processing object at path ${path} with keys:`,
      Object.keys(data)
    );
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      try {
        result[key] = truncateStringsInData(
          value,
          maxLength,
          depth + 1,
          path ? `${path}.${key}` : key
        );
      } catch (e) {
        console.error(`Error processing key ${key} at path ${path}:`, e);
        result[key] = "[ERROR_PROCESSING]";
      }
    }
    return result;
  }

  return data;
}

// Helper to calculate the size of an object
function calculateObjectSize(obj) {
  return JSON.stringify(obj).length;
}

// Helper to process array of objects with size limit
function processArrayWithSizeLimit(array, maxTotalSize, processFunc) {
  let currentSize = 0;
  const result = [];

  for (const item of array) {
    // Process the item first
    const processedItem = processFunc(item);
    const itemSize = calculateObjectSize(processedItem);

    // Check if adding this item would exceed the limit
    if (currentSize + itemSize > maxTotalSize) {
      console.log(
        `Reached size limit (${currentSize}/${maxTotalSize}), truncating array`
      );
      break;
    }

    // Add item and update size
    result.push(processedItem);
    currentSize += itemSize;
    console.log(
      `Added item of size ${itemSize}, total size now: ${currentSize}`
    );
  }

  return result;
}

// Modified processJsonString to handle arrays with size limit
function processJsonString(jsonString, maxLength) {
  console.log("Processing string of length:", jsonString?.length);
  try {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
      console.log(
        "Successfully parsed as JSON, structure:",
        JSON.stringify(Object.keys(parsed))
      );
    } catch (e) {
      console.log("Not valid JSON, treating as string");
      return truncateStringsInData(jsonString, maxLength, 0, "root");
    }

    // If it's an array, process with size limit
    if (Array.isArray(parsed)) {
      console.log("Processing array of objects with size limit");
      const processed = processArrayWithSizeLimit(
        parsed,
        settings.maxLogSize,
        (item) => truncateStringsInData(item, maxLength, 0, "root")
      );
      const result = JSON.stringify(processed);
      console.log(
        `Processed array: ${parsed.length} -> ${processed.length} items`
      );
      return result;
    }

    // Otherwise process as before
    const processed = truncateStringsInData(parsed, maxLength, 0, "root");
    const result = JSON.stringify(processed);
    console.log("Processed JSON string length:", result.length);
    return result;
  } catch (e) {
    console.error("Error in processJsonString:", e);
    return jsonString.substring(0, maxLength) + "... (truncated)";
  }
}

// Helper to send logs to browser-connector
function sendToBrowserConnector(logData) {
  if (!logData) {
    console.error("No log data provided to sendToBrowserConnector");
    return;
  }

  console.log("Sending log data to browser connector:", {
    type: logData.type,
    timestamp: logData.timestamp,
  });

  // Process any string fields that might contain JSON
  const processedData = { ...logData };

  if (logData.type === "network-request") {
    console.log("Processing network request");
    if (processedData.requestBody) {
      console.log(
        "Request body size before:",
        processedData.requestBody.length
      );
      processedData.requestBody = processJsonString(
        processedData.requestBody,
        settings.stringSizeLimit
      );
      console.log("Request body size after:", processedData.requestBody.length);
    }
    if (processedData.responseBody) {
      console.log(
        "Response body size before:",
        processedData.responseBody.length
      );
      processedData.responseBody = processJsonString(
        processedData.responseBody,
        settings.stringSizeLimit
      );
      console.log(
        "Response body size after:",
        processedData.responseBody.length
      );
    }
  }

  processedData.settings = settings;

  fetch("http://127.0.0.1:3025/logs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(processedData),
  })
    .then((response) => response.json())
    .then((result) => {
      if (result.error) {
        console.error("Error from server:", result.error);
      } else {
        console.log("Log sent successfully");
      }
    })
    .catch((error) => {
      console.error("Error sending log data:", error);
    });
}

// Function to wipe logs
function wipeLogs() {
  console.warn("Wiping logs!");
  sendToBrowserConnector({ type: "wipe-logs", timestamp: Date.now() });
}

// Add function to wipe logs
wipeLogs();

// Listen for page refreshes
browser.devtools.network.onNavigated.addListener(() => {
  console.log("Page navigated/refreshed - wiping logs");
  wipeLogs();
});

// Attach debugger
function attachDebugger() {
  console.log("Attaching debugger...");
  browser.debugger
    .attach({ tabId: currentTabId }, "1.3")
    .then(() => {
      isDebuggerAttached = true;
      attachDebuggerRetries = 0; // Reset retries on success
      console.log("Debugger attached successfully!");

      // Enable network and console domains
      browser.debugger.sendCommand({ tabId: currentTabId }, "Network.enable", {});
      browser.debugger.sendCommand({ tabId: currentTabId }, "Console.enable", {});

      // 3) Capture network requests
      browser.debugger.onEvent.addListener((event, method, params) => {
        if (event.tabId === currentTabId) {
          if (method === "Network.requestWillBeSent") {
            // console.log("Network.requestWillBeSent", params);
            const logData = {
              type: "network-request",
              timestamp: Date.now(),
              url: params.request.url,
              method: params.request.method,
              requestHeaders: settings.showRequestHeaders ? params.request.headers : null,
              requestBody: params.request.postData,
            };
            sendToBrowserConnector(logData);
          } else if (method === "Network.responseReceived") {
            // console.log("Network.responseReceived", params);
            const logData = {
              type: "network-response",
              timestamp: Date.now(),
              url: params.response.url,
              status: params.response.status,
              responseHeaders: settings.showResponseHeaders ? params.response.headers : null,
            };
            // console.log("Response Received", logData);
            sendToBrowserConnector(logData);

            // Get response body
            browser.debugger
              .sendCommand(
                { tabId: currentTabId },
                "Network.getResponseBody",
                { requestId: params.requestId }
              )
              .then((response) => {
                if (response) {
                  logData.responseBody = response.body;
                  sendToBrowserConnector(logData);
                }
              })
              .catch((error) => {
                console.error("Error getting response body:", error);
              });
          } else if (method === "Console.messageAdded") {
            // console.log("Console.messageAdded", params.message);
            const logData = {
              type: "console-log",
              timestamp: Date.now(),
              level: params.message.level,
              text: params.message.text,
              source: params.message.source,
              parameters: params.message.parameters,
            };
            sendToBrowserConnector(logData);
          }
        }
      });
    })
    .catch((error) => {
      isDebuggerAttached = false;
      console.error("Failed to attach debugger:", error);
      if (attachDebuggerRetries < MAX_ATTACH_RETRIES) {
        attachDebuggerRetries++;
        console.log(
          `Retrying debugger attach in ${ATTACH_RETRY_DELAY / 1000} seconds...`
        );
        setTimeout(performAttach, ATTACH_RETRY_DELAY);
      } else {
        console.error("Max debugger attach retries reached.");
      }
    });
}

function performAttach() {
  if (!isDebuggerAttached) {
    console.log("Performing debugger attach...");
    attachDebugger();
  } else {
    console.log("Debugger already attached.");
  }
}

// Helper function to detach debugger
function detachDebugger() {
  console.log("Detaching debugger...");
  browser.debugger
    .detach({ tabId: currentTabId })
    .then(() => {
      isDebuggerAttached = false;
      console.log("Debugger detached successfully!");
    })
    .catch((error) => {
      console.error("Failed to detach debugger:", error);
    });
}

// Move the console message listener outside the panel creation
function consoleMessageListener(source, method, params) {
  // console.log("consoleMessageListener", source, method, params);
  if (method === "Console.messageAdded") {
    // console.log("Console.messageAdded", params.message);
    const logData = {
      type: "console-log",
      timestamp: Date.now(),
      level: params.message.level,
      text: params.message.text,
      source: params.message.source,
      parameters: params.message.parameters,
    };
    sendToBrowserConnector(logData);
  }
}

// 2) Use DevTools Protocol to capture console logs
browser.devtools.panels.create("BrowserToolsMCP", "", "panel.html", (panel) => {
  // Initial attach - we'll keep the debugger attached as long as DevTools is open
  attachDebugger();

  panel.onShown.addListener((window) => {
    console.log("Panel shown (window obj):", window);
    // Optionally, re-attach debugger on panel shown
    if (!isDebuggerAttached) {
      performAttach();
    }
  });

  panel.onHidden.addListener(() => {
    console.log("Panel hidden");
    // Optionally, detach debugger on panel hidden
    // detachDebugger();
  });
});

// Function to capture and send element data
function captureAndSendElement() {
  browser.devtools.inspectedWindow.eval(
    `let element = $0;
    if (element) {
      let data = {};
      data.tagName = element.tagName;
      data.id = element.id;
      data.className = element.className;
      data.textContent = element.textContent;
      JSON.stringify(data);
    } else {
      'No element selected';
    }`,
    (result, isException) => {
      if (isException) {
        console.error("Error capturing element data:", isException);
      } else {
        console.log("Captured element data:", result);
        fetch("http://127.0.0.1:3025/element", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: result }),
        })
          .then((response) => response.json())
          .then((result) => {
            if (result.error) {
              console.error("Error from server:", result.error);
            } else {
              console.log("Element data sent successfully");
            }
          })
          .catch((error) => {
            console.error("Error sending element data:", error);
          });
      }
    }
  );
}

// Listen for element selection in the Elements panel
browser.devtools.panels.elements.onSelectionChanged.addListener(() => {
  captureAndSendElement();
});

// WebSocket setup (if needed)
let ws;

function setupWebSocket() {
  // Ensure WebSocket is only initialized once
  if (ws) {
    console.log("WebSocket already initialized");
    return;
  }

  ws = new WebSocket("ws://127.0.0.1:3025/browser-connection");

  ws.onopen = () => {
    console.log("Connected to WebSocket server");
  };

  ws.onmessage = (event) => {
    console.log("Received message from WebSocket server:", event.data);
    // Handle messages from the server if needed
  };

  ws.onclose = () => {
    console.log("Disconnected from WebSocket server");
    ws = null; // Reset WebSocket instance

    // Attempt to reconnect after a delay
    setTimeout(() => {
      console.log("Attempting to reconnect to WebSocket server...");
      setupWebSocket();
    }, 3000); // Reconnect every 3 seconds
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    ws.close(); // Close connection on error
  };
}

// Initialize WebSocket connection when DevTools opens
setupWebSocket();

// Clean up WebSocket when DevTools closes
browser.devtools.onUnload.addListener(() => {
  console.log("DevTools closing, cleaning up WebSocket...");
  if (ws) {
    ws.close();
    ws = null;
  }
});
