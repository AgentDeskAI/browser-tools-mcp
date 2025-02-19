// Listen for messages from the devtools panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_SCREENSHOT" && message.tabId) {
    // Get the inspected window's tab
    chrome.tabs.get(message.tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.error("Error getting tab:", chrome.runtime.lastError);
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      // Get all windows to find the one containing our tab
      chrome.windows.getAll({ populate: true }, (windows) => {
        const targetWindow = windows.find(w =>
          w.tabs.some(t => t.id === message.tabId)
        );

        if (!targetWindow) {
          console.error("Could not find window containing the inspected tab");
          sendResponse({
            success: false,
            error: "Could not find window containing the inspected tab"
          });
          return;
        }

        // Capture screenshot of the window containing our tab
        chrome.tabs.captureVisibleTab(targetWindow.id, { format: "png" }, (dataUrl) => {
          // Ignore DevTools panel capture error if it occurs
          if (chrome.runtime.lastError &&
              !chrome.runtime.lastError.message.includes("devtools://")) {
            console.error("Error capturing screenshot:", chrome.runtime.lastError);
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message,
            });
            return;
          }

          // Send screenshot data to browser connector
          fetch("http://127.0.0.1:3025/screenshot", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: dataUrl,
              path: message.screenshotPath,
            }),
          })
            .then((response) => response.json())
            .then((result) => {
              if (result.error) {
                console.error("Error from server:", result.error);
                sendResponse({ success: false, error: result.error });
              } else {
                console.log("Screenshot saved successfully:", result.path);
                // Send success response even if DevTools capture failed
                sendResponse({
                  success: true,
                  path: result.path,
                  title: tab.title || "Current Tab"
                });
              }
            })
            .catch((error) => {
              console.error("Error sending screenshot data:", error);
              sendResponse({
                success: false,
                error: error.message || "Failed to save screenshot",
              });
            });
        });
      });
    });
    return true; // Required to use sendResponse asynchronously
  }
});
