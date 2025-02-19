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
chrome.storage.local.get(["browserConnectorSettings"], (result) => {
  if (result.browserConnectorSettings) {
    settings = { ...settings, ...result.browserConnectorSettings };
    updateUIFromSettings();
  }
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

// Update screenshot capture functionality
captureScreenshotButton.addEventListener("click", () => {
  captureScreenshotButton.textContent = "Capturing...";

  // Send message to background script to capture screenshot
  chrome.runtime.sendMessage({
    type: "CAPTURE_SCREENSHOT",
    tabId: chrome.devtools.inspectedWindow.tabId,
    screenshotPath: settings.screenshotPath
  }, (response) => {
    console.log("Screenshot capture response:", response);
    if (!response) {
      captureScreenshotButton.textContent = "Failed to capture!";
      console.error("Screenshot capture failed: No response received");
    } else if (!response.success) {
      captureScreenshotButton.textContent = "Failed to capture!";
      console.error("Screenshot capture failed:", response.error);
    } else {
      captureScreenshotButton.textContent = `Captured: ${response.title}`;
      console.log("Screenshot captured successfully:", response.path);
    }
    setTimeout(() => {
      captureScreenshotButton.textContent = "Capture Screenshot";
    }, 2000);
  });
});

// Add wipe logs functionality
const wipeLogsButton = document.getElementById("wipe-logs");
wipeLogsButton.addEventListener("click", () => {
  fetch("http://127.0.0.1:3025/wipelogs", {
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
