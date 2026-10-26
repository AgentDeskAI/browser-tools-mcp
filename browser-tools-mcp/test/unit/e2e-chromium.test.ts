import { afterEach, describe, expect, it, vi } from "vitest";
import { e2eChromiumOptions, wantsHeadedBrowser } from "../helpers/e2e-chromium";

describe("e2e Chromium launch mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays headless when HEADED is unset", () => {
    expect(wantsHeadedBrowser({})).toBe(false);
    expect(e2eChromiumOptions([], {})).toEqual({
      headless: false,
      args: ["--headless=new"],
    });
  });

  it("opens a window only for HEADED=1", () => {
    expect(wantsHeadedBrowser({ HEADED: "1" })).toBe(true);
    expect(e2eChromiumOptions(["--load-extension=/ext"], { HEADED: "1" })).toEqual({
      headless: false,
      args: ["--load-extension=/ext"],
    });
  });

  it("treats every other HEADED value as headless", () => {
    for (const value of ["", "0", "false", "true", "yes", "2"]) {
      expect(wantsHeadedBrowser({ HEADED: value }), `HEADED=${value}`).toBe(false);
      expect(e2eChromiumOptions([], { HEADED: value }).args).toEqual(["--headless=new"]);
    }
  });

  it("keeps the caller's flags after the mode flag and does not mutate them", () => {
    const extra = ["--no-first-run", "--load-extension=/ext"];
    const options = e2eChromiumOptions(extra, {});

    expect(options.args).toEqual(["--headless=new", "--no-first-run", "--load-extension=/ext"]);
    expect(extra).toEqual(["--no-first-run", "--load-extension=/ext"]);
  });

  it("reads HEADED from the process environment when none is passed", () => {
    vi.stubEnv("HEADED", "1");
    expect(wantsHeadedBrowser()).toBe(true);
    expect(e2eChromiumOptions().args).toEqual([]);
  });
});
