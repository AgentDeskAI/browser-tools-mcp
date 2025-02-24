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

// Default port
let serverPort = 3025;
let ws = null;
let wsReconnectTimeout = null;
const WS_RECONNECT_DELAY = 5000; // 5 seconds

// Keep track of debugger state
let isDebuggerAttached = false;
let attachDebuggerRetries = 0;
const currentTabId = chrome.devtools.inspectedWindow.tabId;
const MAX_ATTACH_RETRIES = 3;
const ATTACH_RETRY_DELAY = 1000; // 1 second

// Listen for port updates from the panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PORT_UPDATED") {
    console.log(`Updating port to ${message.port}`);
    serverPort = message.port;
    // Reconnect WebSocket with new port
    if (ws) {
      ws.close();
    }
    setupWebSocket();
  }
});

// Function to get server port
async function getServerPort() {
  try {
    const result = await new Promise(resolve => 
      chrome.storage.local.get(['lastKnownPort'], resolve)
    );
    if (result.lastKnownPort) {
      const port = result.lastKnownPort;
      console.log(`Trying saved port: ${port}`);
      const response = await fetch(`http://127.0.0.1:${port}/.port`);
      if (response.ok) {
        const confirmedPort = await response.text();
        serverPort = parseInt(confirmedPort, 10);
        console.log(`Successfully connected to port: ${serverPort}`);
        return true;
      }
    }
  } catch (error) {
    console.error('Failed to connect to saved port:', error);
  }
  return false;
}

// WebSocket setup function
function setupWebSocket() {
  if (ws) {
    ws.close();
  }

  console.log(`Setting up WebSocket connection on port ${serverPort}`);
  ws = new WebSocket(`ws://localhost:${serverPort}/extension-ws`);

  ws.onopen = () => {
    console.log("Chrome Extension: WebSocket connected");
    if (wsReconnectTimeout) {
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = null;
    }
  };

  ws.onclose = () => {
    console.log("Chrome Extension: WebSocket disconnected, attempting to reconnect...");
    if (!wsReconnectTimeout) {
      wsReconnectTimeout = setTimeout(setupWebSocket, WS_RECONNECT_DELAY);
    }
  };

  ws.onerror = (error) => {
    console.error("Chrome Extension: WebSocket error:", error);
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log("Chrome Extension: Received WebSocket message:", message);

      if (message.type === "take-screenshot") {
        console.log("Chrome Extension: Taking screenshot...");
        chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            console.error("Chrome Extension: Screenshot capture failed:", chrome.runtime.lastError);
            ws.send(JSON.stringify({
              type: "screenshot-error",
              error: chrome.runtime.lastError.message,
              requestId: message.requestId,
            }));
            return;
          }

          console.log("Chrome Extension: Screenshot captured successfully");
          const response = {
            type: "screenshot-data",
            data: dataUrl,
            requestId: message.requestId,
            ...(settings.screenshotPath && { path: settings.screenshotPath }),
          };

          console.log("Chrome Extension: Sending screenshot data response", {
            ...response,
            data: "[base64 data]",
          });

          ws.send(JSON.stringify(response));
        });
      }
    } catch (error) {
      console.error("Chrome Extension: Error processing WebSocket message:", error);
    }
  };
}

// Load saved settings on startup
chrome.storage.local.get(["browserConnectorSettings"], async (result) => {
  if (result.browserConnectorSettings) {
    settings = { ...settings, ...result.browserConnectorSettings };
  }
  // Get server port before setting up WebSocket
  if (await getServerPort()) {
    setupWebSocket();
  } else {
    console.error('Failed to connect to server. Please configure the port in the extension panel.');
  }
});

// Listen for settings updates and screenshot capture requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SETTINGS_UPDATED") {
    settings = message.settings;
  } else if (message.type === "CAPTURE_SCREENSHOT") {
    // Capture screenshot of the current tab
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error("Screenshot capture failed:", chrome.runtime.lastError);
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      // Send screenshot data to browser connector via HTTP POST
      fetch(`http://127.0.0.1:${serverPort}/screenshot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: dataUrl,
          path: settings.screenshotPath,
        }),
      })
        .then((response) => response.json())
        .then((result) => {
          if (result.error) {
            sendResponse({ success: false, error: result.error });
          } else {
            sendResponse({ success: true, path: result.path });
          }
        })
        .catch((error) => {
          console.error("Failed to save screenshot:", error);
          sendResponse({
            success: false,
            error: error.message || "Failed to save screenshot",
          });
        });
    });
    return true; // Required to use sendResponse asynchronously
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

  fetch(`http://127.0.0.1:${serverPort}/extension-log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: logData,
      settings: settings,
    }),
  }).catch((error) => {
    console.error("Failed to send log to browser connector:", error);
  });
}

// Add function to wipe logs
function wipeLogs() {
  fetch(`http://127.0.0.1:${serverPort}/wipelogs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }).catch((error) => {
    console.error("Failed to wipe logs:", error);
  });
}

// Listen for page refreshes
chrome.devtools.network.onNavigated.addListener(() => {
  console.log("Page navigated/refreshed - wiping logs");
  wipeLogs();
});

// 1) Listen for network requests
chrome.devtools.network.onRequestFinished.addListener((request) => {
  if (request._resourceType === "xhr" || request._resourceType === "fetch") {
    request.getContent((responseBody) => {
      const entry = {
        type: "network-request",
        url: request.request.url,
        method: request.request.method,
        status: request.response.status,
        requestHeaders: request.request.headers,
        responseHeaders: request.response.headers,
        requestBody: request.request.postData?.text ?? "",
        responseBody: responseBody ?? "",
      };
      sendToBrowserConnector(entry);
    });
  }
});

// Helper function to attach debugger
async function attachDebugger() {
  // First check if we're already attached to this tab
  chrome.debugger.getTargets((targets) => {
    const isAlreadyAttached = targets.some(
      (target) => target.tabId === currentTabId && target.attached
    );

    if (isAlreadyAttached) {
      console.log("Found existing debugger attachment, detaching first...");
      // Force detach first to ensure clean state
      chrome.debugger.detach({ tabId: currentTabId }, () => {
        // Ignore any errors during detach
        if (chrome.runtime.lastError) {
          console.log("Error during forced detach:", chrome.runtime.lastError);
        }
        // Now proceed with fresh attachment
        performAttach();
      });
    } else {
      // No existing attachment, proceed directly
      performAttach();
    }
  });
}

function performAttach() {
  console.log("Performing debugger attachment to tab:", currentTabId);
  chrome.debugger.attach({ tabId: currentTabId }, "1.3", () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to attach debugger:", chrome.runtime.lastError);
      isDebuggerAttached = false;
      return;
    }

    isDebuggerAttached = true;
    console.log("Debugger successfully attached");

    // Add the event listener when attaching
    chrome.debugger.onEvent.addListener(consoleMessageListener);

    chrome.debugger.sendCommand(
      { tabId: currentTabId },
      "Console.enable",
      {},
      () => {
        if (chrome.runtime.lastError) {
          console.error("Failed to enable console:", chrome.runtime.lastError);
          return;
        }
        console.log("Console API successfully enabled");
      }
    );
  });
}

// Helper function to detach debugger
function detachDebugger() {
  // Remove the event listener first
  chrome.debugger.onEvent.removeListener(consoleMessageListener);

  // Check if debugger is actually attached before trying to detach
  chrome.debugger.getTargets((targets) => {
    const isStillAttached = targets.some(
      (target) => target.tabId === currentTabId && target.attached
    );

    if (!isStillAttached) {
      console.log("Debugger already detached");
      isDebuggerAttached = false;
      return;
    }

    chrome.debugger.detach({ tabId: currentTabId }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Warning during debugger detach:",
          chrome.runtime.lastError
        );
      }
      isDebuggerAttached = false;
      console.log("Debugger detached");
    });
  });
}

// Move the console message listener outside the panel creation
const consoleMessageListener = (source, method, params) => {
  // Only process events for our tab
  if (source.tabId !== currentTabId) {
    return;
  }

  if (method === "Console.messageAdded") {
    console.log("Console message received:", params.message);
    const entry = {
      type: params.message.level === "error" ? "console-error" : "console-log",
      level: params.message.level,
      message: params.message.text,
      timestamp: Date.now(),
    };
    console.log("Sending console entry:", entry);
    sendToBrowserConnector(entry);
  }
};

// 2) Use DevTools Protocol to capture console logs
chrome.devtools.panels.create("BrowserToolsMCP", "", "panel.html", (panel) => {
  // Initial attach - we'll keep the debugger attached as long as DevTools is open
  attachDebugger();

  // Handle panel showing
  panel.onShown.addListener((panelWindow) => {
    if (!isDebuggerAttached) {
      attachDebugger();
    }
  });
});

// Clean up when DevTools window is closed
window.addEventListener("unload", () => {
  detachDebugger();
  if (ws) {
    ws.close();
  }
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
  }
});

// Function to capture and send element data
function captureAndSendElement() {
  chrome.devtools.inspectedWindow.eval(
    `(function() {
      const el = $0;  // $0 is the currently selected element in DevTools
      if (!el) return null;

      const rect = el.getBoundingClientRect();
      
      return {
        tagName: el.tagName,
        id: el.id,
        className: el.className,
        textContent: el.textContent?.substring(0, 100),
        attributes: Array.from(el.attributes).map(attr => ({
          name: attr.name,
          value: attr.value
        })),
        dimensions: {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left
        },
        innerHTML: el.innerHTML.substring(0, 500)
      };
    })()`,
    (result, isException) => {
      if (isException || !result) return;

      console.log("Element selected:", result);

      // Send to browser connector
      sendToBrowserConnector({
        type: "selected-element",
        timestamp: Date.now(),
        element: result,
      });
    }
  );
}

// Listen for element selection in the Elements panel
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  captureAndSendElement();
});
