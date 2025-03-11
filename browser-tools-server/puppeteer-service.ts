import fs from "fs";
import puppeteer from "puppeteer-core";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import * as ChromeLauncher from "chrome-launcher";
// ===== Configuration Types and Defaults =====

/**
 * Configuration interface for the Puppeteer service
 */
export interface PuppeteerServiceConfig {
  // Browser preferences
  preferredBrowsers?: string[]; // Order of browser preference ("chrome", "edge", "brave", "firefox")
  customBrowserPaths?: { [key: string]: string }; // Custom browser executable paths

  // Connection settings
  debugPorts?: number[]; // Ports to try when connecting to existing browsers
  connectionTimeout?: number; // Timeout for connection attempts in ms
  maxRetries?: number; // Maximum number of retries for connections

  // Browser cleanup settings
  browserCleanupTimeout?: number; // Timeout before closing inactive browsers (ms)

  // Performance settings
  blockResourceTypes?: string[]; // Resource types to block for performance
}

// Default configuration values
const DEFAULT_CONFIG: PuppeteerServiceConfig = {
  preferredBrowsers: ["chrome", "edge", "brave", "firefox"],
  debugPorts: [9222, 9223, 9224, 9225],
  connectionTimeout: 10000,
  maxRetries: 3,
  browserCleanupTimeout: 60000,
  blockResourceTypes: ["image", "font", "media"],
};

// Browser support notes:
// - Chrome/Chromium: Fully supported (primary target)
// - Edge: Fully supported (Chromium-based)
// - Brave: Fully supported (Chromium-based)
// - Firefox: Partially supported (some features may not work)
// - Safari: Not supported by Puppeteer

// ===== Global State =====

// Current active configuration
let currentConfig: PuppeteerServiceConfig = { ...DEFAULT_CONFIG };

// Browser instance management
let headlessBrowserInstance: puppeteer.Browser | null = null;
let launchedBrowserWSEndpoint: string | null = null;

// Cleanup management
let browserCleanupTimeout: NodeJS.Timeout | null = null;
let BROWSER_CLEANUP_TIMEOUT = 60000; // 60 seconds default

// Cache for browser executable paths
let detectedBrowserPath: string | null = null;

// ===== Configuration Functions =====

/**
 * Configure the Puppeteer service with custom settings
 * @param config Partial configuration to override defaults
 */
export function configurePuppeteerService(
  config: Partial<PuppeteerServiceConfig>
): void {
  currentConfig = { ...DEFAULT_CONFIG, ...config };

  // Update the timeout if it was changed
  if (
    config.browserCleanupTimeout &&
    config.browserCleanupTimeout !== BROWSER_CLEANUP_TIMEOUT
  ) {
    BROWSER_CLEANUP_TIMEOUT = config.browserCleanupTimeout;
  }

  console.log("Puppeteer service configured:", currentConfig);
}

// ===== Browser Management =====

/**
 * Get or create a headless browser instance
 * @returns Promise resolving to a browser instance
 */
async function getHeadlessBrowserInstance(): Promise<puppeteer.Browser> {
  console.log("Browser instance request started");

  // Cancel any scheduled cleanup
  cancelScheduledCleanup();

  // Try to reuse existing browser
  if (headlessBrowserInstance) {
    try {
      const pages = await headlessBrowserInstance.pages();
      console.log(
        `Reusing existing headless browser with ${pages.length} pages`
      );
      return headlessBrowserInstance;
    } catch (error) {
      console.log(
        "Existing browser instance is no longer valid, creating a new one"
      );
      headlessBrowserInstance = null;
      launchedBrowserWSEndpoint = null;
    }
  }

  // Create a new browser instance
  return launchNewBrowser();
}

/**
 * Launches a new browser instance
 * @returns Promise resolving to a browser instance
 */
async function launchNewBrowser(): Promise<puppeteer.Browser> {
  console.log("Creating new headless browser instance");

  // Setup temporary user data directory
  const userDataDir = createTempUserDataDir();
  let browser: puppeteer.Browser | null = null;

  try {
    // Configure launch options
    const launchOptions = configureLaunchOptions(userDataDir);

    // Set custom browser executable
    await setCustomBrowserExecutable(launchOptions);

    // Launch the browser
    console.log(
      "Launching browser with options:",
      JSON.stringify({
        headless: launchOptions.headless,
        executablePath: launchOptions.executablePath,
      })
    );

    browser = await puppeteer.launch(launchOptions);

    // Store references to the browser instance
    launchedBrowserWSEndpoint = browser.wsEndpoint();
    headlessBrowserInstance = browser;

    // Setup cleanup handlers
    setupBrowserCleanupHandlers(browser, userDataDir);

    console.log("Browser ready");
    return browser;
  } catch (error) {
    console.error("Failed to launch browser:", error);

    // Clean up resources
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error("Error closing browser:", closeError);
      }
      headlessBrowserInstance = null;
      launchedBrowserWSEndpoint = null;
    }

    // Clean up the temporary directory
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (fsError) {
      console.error("Error removing temporary directory:", fsError);
    }

    throw error;
  }
}

/**
 * Creates a temporary user data directory for the browser
 * @returns Path to the created directory
 */
function createTempUserDataDir(): string {
  const tempDir = os.tmpdir();
  const uniqueId = `${Date.now().toString()}-${Math.random()
    .toString(36)
    .substring(2)}`;
  const userDataDir = path.join(tempDir, `browser-debug-profile-${uniqueId}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`Using temporary user data directory: ${userDataDir}`);
  return userDataDir;
}

/**
 * Configures browser launch options
 * @param userDataDir Path to the user data directory
 * @returns Launch options object
 */
function configureLaunchOptions(userDataDir: string): any {
  const launchOptions: any = {
    args: [
      "--remote-debugging-port=0", // Use dynamic port
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-background-networking",
      "--disable-backgrounding-occluded-windows",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-pings",
      "--safebrowsing-disable-auto-update",
    ],
  };

  // Add headless mode (using any to bypass type checking issues)
  launchOptions.headless = "new";

  return launchOptions;
}

/**
 * Sets a custom browser executable path if configured
 * @param launchOptions Launch options object to modify
 */
async function setCustomBrowserExecutable(launchOptions: any): Promise<void> {
  // First, try to use a custom browser path from configuration
  if (
    currentConfig.customBrowserPaths &&
    Object.keys(currentConfig.customBrowserPaths).length > 0
  ) {
    const preferredBrowsers = currentConfig.preferredBrowsers || [
      "chrome",
      "edge",
      "brave",
      "firefox",
    ];

    for (const browser of preferredBrowsers) {
      if (
        currentConfig.customBrowserPaths[browser] &&
        fs.existsSync(currentConfig.customBrowserPaths[browser])
      ) {
        launchOptions.executablePath =
          currentConfig.customBrowserPaths[browser];

        // Set product to firefox if using Firefox browser
        if (browser === "firefox") {
          launchOptions.product = "firefox";
        }

        console.log(
          `Using custom ${browser} path: ${launchOptions.executablePath}`
        );
        return;
      }
    }
  }

  // If no custom path is found, use cached path or detect a new one
  try {
    if (detectedBrowserPath && fs.existsSync(detectedBrowserPath)) {
      console.log(`Using cached browser path: ${detectedBrowserPath}`);
      launchOptions.executablePath = detectedBrowserPath;

      // Check if the detected browser is Firefox
      if (detectedBrowserPath.includes("firefox")) {
        launchOptions.product = "firefox";
        console.log("Setting product to firefox for Firefox browser");
      }
    } else {
      detectedBrowserPath = await findBrowserExecutablePath();
      launchOptions.executablePath = detectedBrowserPath;

      // Check if the detected browser is Firefox
      if (detectedBrowserPath.includes("firefox")) {
        launchOptions.product = "firefox";
        console.log("Setting product to firefox for Firefox browser");
      }

      console.log(
        `Using detected browser path: ${launchOptions.executablePath}`
      );
    }
  } catch (error) {
    console.error("Failed to detect browser executable path:", error);
    throw new Error(
      "No browser executable path found. Please specify a custom browser path in the configuration."
    );
  }
}

/**
 * Find a browser executable path on the current system
 * @returns Path to a browser executable
 */
async function findBrowserExecutablePath(): Promise<string> {
  // Try to use chrome-launcher (most reliable method)
  try {
    console.log("Attempting to find Chrome using chrome-launcher...");

    // Launch Chrome using chrome-launcher
    const chrome = await ChromeLauncher.launch({
      chromeFlags: ["--headless"],
      handleSIGINT: false,
    });

    // chrome-launcher stores the Chrome executable path differently than Puppeteer
    // Let's try different approaches to get it

    // First check if we can access it directly
    let chromePath = "";

    // Chrome version data often contains the path
    if (chrome.process && chrome.process.spawnfile) {
      chromePath = chrome.process.spawnfile;
      console.log("Found Chrome path from process.spawnfile");
    } else {
      // Try to get the Chrome path from chrome-launcher
      // In newer versions, it's directly accessible
      console.log("Trying to determine Chrome path using other methods");

      // This will actually return the real Chrome path for us
      // chrome-launcher has this inside but doesn't expose it directly
      const possiblePaths = [
        process.env.CHROME_PATH,
        // Common paths by OS
        ...(process.platform === "darwin"
          ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
          : process.platform === "win32"
          ? [
              `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
              `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
            ]
          : ["/usr/bin/google-chrome"]),
      ].filter(Boolean);

      // Use the first valid path
      for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) {
          chromePath = p;
          console.log("Found Chrome path from common locations");
          break;
        }
      }
    }

    // Always kill the Chrome instance we just launched
    await chrome.kill();

    if (chromePath) {
      console.log(`Chrome found via chrome-launcher: ${chromePath}`);
      return chromePath;
    } else {
      console.log("Chrome launched but couldn't determine executable path");
    }
  } catch (error) {
    // Check if it's a ChromeNotInstalledError
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("No Chrome installations found") ||
      (error as any)?.code === "ERR_LAUNCHER_NOT_INSTALLED"
    ) {
      console.log("Chrome not installed. Falling back to manual detection");
    } else {
      console.error("Failed to find Chrome using chrome-launcher:", error);
      console.log("Falling back to manual detection");
    }
  }

  // If chrome-launcher failed, use manual detection

  const platform = process.platform;
  const preferredBrowsers = currentConfig.preferredBrowsers || [
    "chrome",
    "edge",
    "brave",
    "firefox",
  ];

  console.log(`Attempting to detect browser executable path on ${platform}...`);

  // Platform-specific detection strategies
  if (platform === "win32") {
    // Windows - try registry detection for Chrome
    let registryPath = null;
    try {
      console.log("Checking Windows registry for Chrome...");
      // Try HKLM first
      const regOutput = execSync(
        'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: "utf8" }
      );

      // Extract path from registry output
      const match = regOutput.match(/REG_(?:SZ|EXPAND_SZ)\s+([^\s]+)/i);
      if (match && match[1]) {
        registryPath = match[1].replace(/\\"/g, "");
        // Verify the path exists
        if (fs.existsSync(registryPath)) {
          console.log(`Found Chrome via HKLM registry: ${registryPath}`);
          return registryPath;
        }
      }
    } catch (e) {
      // Try HKCU if HKLM fails
      try {
        console.log("Checking user registry for Chrome...");
        const regOutput = execSync(
          'reg query "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
          { encoding: "utf8" }
        );

        // Extract path from registry output
        const match = regOutput.match(/REG_(?:SZ|EXPAND_SZ)\s+([^\s]+)/i);
        if (match && match[1]) {
          registryPath = match[1].replace(/\\"/g, "");
          // Verify the path exists
          if (fs.existsSync(registryPath)) {
            console.log(`Found Chrome via HKCU registry: ${registryPath}`);
            return registryPath;
          }
        }
      } catch (innerError) {
        console.log(
          "Failed to find Chrome via registry, continuing with path checks"
        );
      }
    }

    // Try to find Chrome through BLBeacon registry key (version info)
    try {
      console.log("Checking Chrome BLBeacon registry...");
      const regOutput = execSync(
        'reg query "HKEY_CURRENT_USER\\Software\\Google\\Chrome\\BLBeacon" /v version',
        { encoding: "utf8" }
      );

      if (regOutput) {
        // If BLBeacon exists, Chrome is likely installed in the default location
        const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
        const programFilesX86 =
          process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

        const defaultChromePaths = [
          path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
          path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
        ];

        for (const chromePath of defaultChromePaths) {
          if (fs.existsSync(chromePath)) {
            console.log(
              `Found Chrome via BLBeacon registry hint: ${chromePath}`
            );
            return chromePath;
          }
        }
      }
    } catch (e) {
      console.log("Failed to find Chrome via BLBeacon registry");
    }

    // Continue with regular path checks
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

    // Common Windows browser paths
    const winBrowserPaths = {
      chrome: [
        path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      ],
      edge: [
        path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
        path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      ],
      brave: [
        path.join(
          programFiles,
          "BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        ),
        path.join(
          programFilesX86,
          "BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        ),
      ],
      firefox: [
        path.join(programFiles, "Mozilla Firefox\\firefox.exe"),
        path.join(programFilesX86, "Mozilla Firefox\\firefox.exe"),
      ],
    };

    // Check each browser in preferred order
    for (const browser of preferredBrowsers) {
      const paths =
        winBrowserPaths[browser as keyof typeof winBrowserPaths] || [];
      for (const browserPath of paths) {
        if (fs.existsSync(browserPath)) {
          console.log(`Found ${browser} at ${browserPath}`);
          return browserPath;
        }
      }
    }
  } else if (platform === "darwin") {
    // macOS browser paths
    const macBrowserPaths = {
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      firefox: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
      safari: ["/Applications/Safari.app/Contents/MacOS/Safari"],
    };

    // Check each browser in preferred order
    for (const browser of preferredBrowsers) {
      const paths =
        macBrowserPaths[browser as keyof typeof macBrowserPaths] || [];
      for (const browserPath of paths) {
        if (fs.existsSync(browserPath)) {
          console.log(`Found ${browser} at ${browserPath}`);
          // Safari is detected but not supported by Puppeteer
          if (browser === "safari") {
            console.log(
              "Safari detected but not supported by Puppeteer. Continuing search..."
            );
            continue;
          }
          return browserPath;
        }
      }
    }
  } else if (platform === "linux") {
    // Linux browser commands
    const linuxBrowserCommands = {
      chrome: ["google-chrome", "chromium", "chromium-browser"],
      edge: ["microsoft-edge"],
      brave: ["brave-browser"],
      firefox: ["firefox"],
    };

    // Check each browser in preferred order
    for (const browser of preferredBrowsers) {
      const commands =
        linuxBrowserCommands[browser as keyof typeof linuxBrowserCommands] ||
        [];
      for (const cmd of commands) {
        try {
          // Use more universal commands for Linux to find executables
          // command -v works in most shells, fallback to which or type
          const browserPath = execSync(
            `command -v ${cmd} || which ${cmd} || type -p ${cmd} 2>/dev/null`,
            { encoding: "utf8" }
          ).trim();

          if (browserPath && fs.existsSync(browserPath)) {
            console.log(`Found ${browser} at ${browserPath}`);
            return browserPath;
          }
        } catch (e) {
          // Command not found, continue to next
        }
      }
    }

    // Additional check for unusual locations on Linux
    const alternativeLocations = [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/snap/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ];

    for (const location of alternativeLocations) {
      if (fs.existsSync(location)) {
        console.log(`Found browser at alternative location: ${location}`);
        return location;
      }
    }
  }

  throw new Error(
    `No browser executable found for platform ${platform}. Please specify a custom browser path.`
  );
}

/**
 * Sets up cleanup handlers for the browser instance
 * @param browser Browser instance
 * @param userDataDir Path to the user data directory to clean up
 */
function setupBrowserCleanupHandlers(
  browser: puppeteer.Browser,
  userDataDir: string
): void {
  browser.on("disconnected", () => {
    console.log(`Browser disconnected. Scheduling cleanup for: ${userDataDir}`);

    // Clear any existing cleanup timeout when browser is disconnected
    cancelScheduledCleanup();

    // Delayed cleanup to avoid conflicts with potential new browser instances
    setTimeout(() => {
      // Only remove the directory if no new browser has been launched
      if (!headlessBrowserInstance) {
        console.log(`Cleaning up temporary directory: ${userDataDir}`);
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
          console.log(`Successfully removed directory: ${userDataDir}`);
        } catch (error) {
          console.error(`Failed to remove directory ${userDataDir}:`, error);
        }
      } else {
        console.log(
          `Skipping cleanup for ${userDataDir} as new browser instance is active`
        );
      }
    }, 5000); // 5-second delay for cleanup

    // Reset browser instance variables
    launchedBrowserWSEndpoint = null;
    headlessBrowserInstance = null;
  });
}

// ===== Cleanup Management =====

/**
 * Cancels any scheduled browser cleanup
 */
function cancelScheduledCleanup(): void {
  if (browserCleanupTimeout) {
    console.log("Cancelling scheduled browser cleanup");
    clearTimeout(browserCleanupTimeout);
    browserCleanupTimeout = null;
  }
}

/**
 * Schedules automatic cleanup of the browser instance after inactivity
 */
export function scheduleBrowserCleanup(): void {
  // Clear any existing timeout first
  cancelScheduledCleanup();

  // Only schedule cleanup if we have an active browser instance
  if (headlessBrowserInstance) {
    console.log(
      `Scheduling browser cleanup in ${BROWSER_CLEANUP_TIMEOUT / 1000} seconds`
    );

    browserCleanupTimeout = setTimeout(() => {
      console.log("Executing scheduled browser cleanup");
      if (headlessBrowserInstance) {
        console.log("Closing headless browser instance");
        headlessBrowserInstance.close();
        headlessBrowserInstance = null;
        launchedBrowserWSEndpoint = null;
      }
      browserCleanupTimeout = null;
    }, BROWSER_CLEANUP_TIMEOUT);
  }
}

// ===== Public Browser Connection API =====

/**
 * Connects to a headless browser for web operations
 * @param url The URL to navigate to
 * @param options Connection and emulation options
 * @returns Promise resolving to browser, port, and page objects
 */
export async function connectToHeadlessBrowser(
  url: string,
  options: {
    blockResources?: boolean;
    customResourceBlockList?: string[];
    emulateDevice?: "mobile" | "tablet" | "desktop";
    emulateNetworkCondition?: "slow3G" | "fast3G" | "4G" | "offline";
    viewport?: { width: number; height: number };
    locale?: string;
    timezoneId?: string;
    userAgent?: string;
    waitForSelector?: string;
    waitForTimeout?: number;
    cookies?: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
    }>;
    headers?: Record<string, string>;
  } = {}
): Promise<{
  browser: puppeteer.Browser;
  port: number;
  page: puppeteer.Page;
}> {
  console.log(
    `Connecting to headless browser for ${url}${
      options.blockResources ? " (blocking non-essential resources)" : ""
    }`
  );

  try {
    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      throw new Error(`Invalid URL format: ${url}`);
    }

    // Get or create a browser instance
    const browser = await getHeadlessBrowserInstance();

    if (!launchedBrowserWSEndpoint) {
      throw new Error("Failed to retrieve WebSocket endpoint for browser");
    }

    // Extract port from WebSocket endpoint
    const port = parseInt(
      launchedBrowserWSEndpoint.split(":")[2].split("/")[0]
    );

    // Always create a new page for each audit to avoid request interception conflicts
    console.log("Creating a new page for this audit");
    const page = await browser.newPage();

    // Set a longer timeout for navigation
    const navigationTimeout = 10000; // 10 seconds
    page.setDefaultNavigationTimeout(navigationTimeout);

    // Navigate to the URL
    console.log(`Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2", // Wait until there are no more network connections for at least 500ms
      timeout: navigationTimeout,
    });

    // Set custom headers if provided
    if (options.headers && Object.keys(options.headers).length > 0) {
      await page.setExtraHTTPHeaders(options.headers);
      console.log("Set custom HTTP headers");
    }

    // Set cookies if provided
    if (options.cookies && options.cookies.length > 0) {
      const urlObj = new URL(url);
      const cookiesWithDomain = options.cookies.map((cookie) => ({
        ...cookie,
        domain: cookie.domain || urlObj.hostname,
        path: cookie.path || "/",
      }));
      await page.setCookie(...cookiesWithDomain);
      console.log(`Set ${options.cookies.length} cookies`);
    }

    // Set custom viewport if specified
    if (options.viewport) {
      await page.setViewport(options.viewport);
      console.log(
        `Set viewport to ${options.viewport.width}x${options.viewport.height}`
      );
    } else if (options.emulateDevice) {
      // Set common device emulation presets
      let viewport;
      let userAgent = options.userAgent;

      switch (options.emulateDevice) {
        case "mobile":
          viewport = {
            width: 375,
            height: 667,
            isMobile: true,
            hasTouch: true,
          };
          userAgent =
            userAgent ||
            "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X)";
          break;
        case "tablet":
          viewport = {
            width: 768,
            height: 1024,
            isMobile: true,
            hasTouch: true,
          };
          userAgent =
            userAgent || "Mozilla/5.0 (iPad; CPU OS 13_2_3 like Mac OS X)";
          break;
        case "desktop":
        default:
          viewport = {
            width: 1280,
            height: 800,
            isMobile: false,
            hasTouch: false,
          };
          break;
      }

      await page.setViewport(viewport);
      if (userAgent) await page.setUserAgent(userAgent);

      console.log(`Emulating ${options.emulateDevice} device`);
    }

    // Set locale and timezone if provided
    if (options.locale) {
      await page.evaluateOnNewDocument((locale) => {
        Object.defineProperty(navigator, "language", { get: () => locale });
        Object.defineProperty(navigator, "languages", { get: () => [locale] });
      }, options.locale);
      console.log(`Set locale to ${options.locale}`);
    }

    if (options.timezoneId) {
      await page.emulateTimezone(options.timezoneId);
      console.log(`Set timezone to ${options.timezoneId}`);
    }

    // Emulate network conditions if specified
    if (options.emulateNetworkCondition) {
      // Define network condition types that match puppeteer's expected format
      interface PuppeteerNetworkConditions {
        offline: boolean;
        latency?: number;
        download?: number;
        upload?: number;
      }

      let networkConditions: PuppeteerNetworkConditions;

      switch (options.emulateNetworkCondition) {
        case "slow3G":
          networkConditions = {
            offline: false,
            latency: 400,
            download: (500 * 1024) / 8,
            upload: (500 * 1024) / 8,
          };
          break;
        case "fast3G":
          networkConditions = {
            offline: false,
            latency: 150,
            download: (1.5 * 1024 * 1024) / 8,
            upload: (750 * 1024) / 8,
          };
          break;
        case "4G":
          networkConditions = {
            offline: false,
            latency: 50,
            download: (4 * 1024 * 1024) / 8,
            upload: (2 * 1024 * 1024) / 8,
          };
          break;
        case "offline":
          networkConditions = { offline: true };
          break;
        default:
          networkConditions = { offline: false };
      }

      // @ts-ignore - Property might not be in types but is supported
      await page.emulateNetworkConditions(networkConditions);
      console.log(
        `Emulating ${options.emulateNetworkCondition} network conditions`
      );
    }

    // Check if we should block resources based on the options
    if (options.blockResources) {
      const resourceTypesToBlock = options.customResourceBlockList ||
        currentConfig.blockResourceTypes || ["image", "font", "media"];

      await page.setRequestInterception(true);
      page.on("request", (request) => {
        // Block unnecessary resources to speed up loading
        const resourceType = request.resourceType();
        if (resourceTypesToBlock.includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      console.log(
        `Blocking resource types: ${resourceTypesToBlock.join(", ")}`
      );
    }

    // Wait for a specific selector if requested
    if (options.waitForSelector) {
      try {
        console.log(`Waiting for selector: ${options.waitForSelector}`);
        await page.waitForSelector(options.waitForSelector, {
          timeout: options.waitForTimeout || 30000,
        });
      } catch (selectorError: any) {
        console.warn(
          `Failed to find selector "${options.waitForSelector}": ${selectorError.message}`
        );
        // Continue anyway, don't fail the whole operation
      }
    }

    return { browser, port, page };
  } catch (error) {
    console.error("Failed to connect to headless browser:", error);
    throw new Error(
      `Failed to connect to headless browser: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
