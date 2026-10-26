/**
 * How the end-to-end suites launch Chromium.
 *
 * The extension suites need the real Chromium binary. Playwright's
 * `headless: true` selects chrome-headless-shell, a separate build that
 * cannot load extensions or a DevTools page, and both of those are required
 * here. Chrome's new headless mode is the real browser with no window, and
 * it can do both, so the default passes `--headless=new` while leaving
 * Playwright's own `headless` flag off (that flag is what swaps the binary).
 *
 * A visible window is opt-in: `HEADED=1`. Any other value, including leaving
 * the variable unset, stays headless. The profile is always a fresh temporary
 * directory created by the suite, never the operator's own Chrome profile.
 */

export function wantsHeadedBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["HEADED"] === "1";
}

/**
 * Playwright launch fields for the end-to-end browser.
 *
 * `args` are appended after the mode flag. `headless` is always false; the
 * file comment says why.
 */
export function e2eChromiumOptions(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): { headless: false; args: string[] } {
  const mode = wantsHeadedBrowser(env) ? [] : ["--headless=new"];
  return { headless: false, args: [...mode, ...args] };
}
