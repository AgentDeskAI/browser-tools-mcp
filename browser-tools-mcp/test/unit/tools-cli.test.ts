import { describe, expect, it } from "vitest";
import { parseToolsCli } from "../../src/tools-cli";
import { ALL_TOOL_NAMES } from "../../src/mcp/server";
import { INVOKABLE_TOOL_NAMES } from "../../src/mcp/tool-invoke";

describe("tools CLI", () => {
  it("maps --allow-actions to connector allowInput, not allowEval", () => {
    const parsed = parseToolsCli(["--allow-actions", "getPageInfo"], {});
    expect(parsed.options.allowInput).toBe(true);
    expect(parsed.options.allowEval).toBe(false);
    expect(parsed.command).toBe("getPageInfo");
  });

  it("rejects MCP-only capability flags", () => {
    expect(() => parseToolsCli(["--allow-input", "getPageInfo"], {})).toThrow(/allow-actions/);
    expect(() => parseToolsCli(["--allow-eval"], {})).toThrow(/allow-actions/);
  });

  it("lists the same tool names as the MCP server and invoke layer", () => {
    expect(new Set(INVOKABLE_TOOL_NAMES)).toEqual(new Set(ALL_TOOL_NAMES));
  });
});
