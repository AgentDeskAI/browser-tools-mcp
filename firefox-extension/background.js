// Listen for messages from the devtools panel
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_SCREENSHOT" && message.tabId) {
    // Get the inspected window's tab
    browser.tabs.get(message.tabId).then((tab) => {
      // Get all windows to find the one containing our tab
      browser.windows.getAll({ populate: true }).then((windows) => {
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
        browser.tabs.captureVisibleTab(targetWindow.id, { format: "png" }).then((dataUrl) => {
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
        }).catch((error) => {
          console.error("Error capturing screenshot:", error);
          sendResponse({
            success: false,
            error: error.message,
          });
        });
      }).catch((error) => {
        console.error("Error getting windows:", error);
        sendResponse({
          success: false,
          error: error.message,
        });
      });
    }).catch((error) => {
      console.error("Error getting tab:", error);
      sendResponse({
        success: false,
        error: error.message,
      });
    });
    
    return true; // Required to use sendResponse asynchronously
  }
});
