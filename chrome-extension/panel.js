// Store settings
let settings = {
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  showRequestHeaders: false,
  showResponseHeaders: false,
  maxLogSize: 20000,
  screenshotPath: "",
};

// Load saved settings on startup
chrome.storage.local.get(["browserConnectorSettings", "lastKnownPort"], (result) => {
  if (result.browserConnectorSettings) {
    settings = { ...settings, ...result.browserConnectorSettings };
    updateUIFromSettings();
  }
  const port = result.lastKnownPort || 3025;
  document.getElementById('server-port').value = port;
  updateConnectionStatus();
});

// Initialize UI elements
const logLimitInput = document.getElementById("log-limit");
const queryLimitInput = document.getElementById("query-limit");
const stringSizeLimitInput = document.getElementById("string-size-limit");
const showRequestHeadersCheckbox = document.getElementById(
  "show-request-headers"
);
const showResponseHeadersCheckbox = document.getElementById(
  "show-response-headers"
);
const maxLogSizeInput = document.getElementById("max-log-size");
const screenshotPathInput = document.getElementById("screenshot-path");
const captureScreenshotButton = document.getElementById("capture-screenshot");

// Initialize collapsible advanced settings
const advancedSettingsHeader = document.getElementById(
  "advanced-settings-header"
);
const advancedSettingsContent = document.getElementById(
  "advanced-settings-content"
);
const chevronIcon = advancedSettingsHeader.querySelector(".chevron");

advancedSettingsHeader.addEventListener("click", () => {
  advancedSettingsContent.classList.toggle("visible");
  chevronIcon.classList.toggle("open");
});

// Update UI from settings
function updateUIFromSettings() {
  logLimitInput.value = settings.logLimit;
  queryLimitInput.value = settings.queryLimit;
  stringSizeLimitInput.value = settings.stringSizeLimit;
  showRequestHeadersCheckbox.checked = settings.showRequestHeaders;
  showResponseHeadersCheckbox.checked = settings.showResponseHeaders;
  maxLogSizeInput.value = settings.maxLogSize;
  screenshotPathInput.value = settings.screenshotPath;
}

// Save settings
function saveSettings() {
  chrome.storage.local.set({ browserConnectorSettings: settings });
  // Notify devtools.js about settings change
  chrome.runtime.sendMessage({
    type: "SETTINGS_UPDATED",
    settings,
  });
}

// Add event listeners for all inputs
logLimitInput.addEventListener("change", (e) => {
  settings.logLimit = parseInt(e.target.value, 10);
  saveSettings();
});

queryLimitInput.addEventListener("change", (e) => {
  settings.queryLimit = parseInt(e.target.value, 10);
  saveSettings();
});

stringSizeLimitInput.addEventListener("change", (e) => {
  settings.stringSizeLimit = parseInt(e.target.value, 10);
  saveSettings();
});

showRequestHeadersCheckbox.addEventListener("change", (e) => {
  settings.showRequestHeaders = e.target.checked;
  saveSettings();
});

showResponseHeadersCheckbox.addEventListener("change", (e) => {
  settings.showResponseHeaders = e.target.checked;
  saveSettings();
});

maxLogSizeInput.addEventListener("change", (e) => {
  settings.maxLogSize = parseInt(e.target.value, 10);
  saveSettings();
});

screenshotPathInput.addEventListener("change", (e) => {
  settings.screenshotPath = e.target.value;
  saveSettings();
});

// Add screenshot capture functionality
captureScreenshotButton.addEventListener("click", () => {
  captureScreenshotButton.textContent = "Capturing...";

  // Send message to devtools.js to capture screenshot
  chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
    if (!response) {
      captureScreenshotButton.textContent = "Failed to capture!";
      console.error("Screenshot capture failed: No response received");
    } else if (!response.success) {
      captureScreenshotButton.textContent = "Failed to capture!";
      console.error("Screenshot capture failed:", response.error);
    } else {
      captureScreenshotButton.textContent = "Screenshot captured!";
    }
    setTimeout(() => {
      captureScreenshotButton.textContent = "Capture Screenshot";
    }, 2000);
  });
});

// Add wipe logs functionality
const wipeLogsButton = document.getElementById("wipe-logs");
wipeLogsButton.addEventListener("click", () => {
  const port = document.getElementById('server-port').value;
  fetch(`http://127.0.0.1:${port}/wipelogs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })
    .then((response) => response.json())
    .then((result) => {
      console.log("Logs wiped successfully:", result.message);
      wipeLogsButton.textContent = "Logs Wiped!";
      setTimeout(() => {
        wipeLogsButton.textContent = "Wipe All Logs";
      }, 2000);
    })
    .catch((error) => {
      console.error("Failed to wipe logs:", error);
      wipeLogsButton.textContent = "Failed to Wipe Logs";
      setTimeout(() => {
        wipeLogsButton.textContent = "Wipe All Logs";
      }, 2000);
    });
});

// Handle port configuration
document.getElementById('connect-server').addEventListener('click', async function() {
  const port = parseInt(document.getElementById('server-port').value, 10);
  if (port < 1 || port > 65535) {
    alert('Please enter a valid port number (1-65535)');
    return;
  }

  try {
    // Test connection to new port
    const response = await fetch(`http://127.0.0.1:${port}/.port`);
    if (response.ok) {
      const confirmedPort = await response.text();
      if (parseInt(confirmedPort, 10) === port) {
        // Save the port
        chrome.storage.local.set({ lastKnownPort: port });
        // Notify devtools script to reconnect
        chrome.runtime.sendMessage({
          type: 'PORT_UPDATED',
          port: port
        });
        updateConnectionStatus(true);
      }
    } else {
      throw new Error('Server not responding');
    }
  } catch (error) {
    console.error('Connection failed:', error);
    updateConnectionStatus(false);
    alert(`Could not connect to server on port ${port}. Make sure the server is running with MCP_PORT=${port}`);
  }
});

function updateConnectionStatus(connected = null) {
  const statusDiv = document.getElementById('connection-status');
  const port = document.getElementById('server-port').value;

  if (connected === null) {
    // Check current connection
    fetch(`http://127.0.0.1:${port}/.port`)
      .then(response => response.ok ? updateConnectionStatus(true) : updateConnectionStatus(false))
      .catch(() => updateConnectionStatus(false));
    return;
  }

  statusDiv.innerHTML = connected ? 
    '<span style="color: #4caf50">&#x2713; Connected!</span>' :
    '<span style="color: #f44336">&#x2717; Disconnected</span>';
}
