# @agentdeskai/browser-tools-server

Standalone connector for BrowserTools MCP.

**Most people do not need this package.** Since 2.0 the connector is embedded in
`@agentdeskai/browser-tools-mcp`, so a normal setup is a single process.

Run this only when several MCP clients should share one browser session:

```bash
npx @agentdeskai/browser-tools-server
```

Every `browser-tools-mcp` process started afterwards attaches to it
automatically instead of starting its own. This process is the one whose
`--only` / `--exclude` the local API enforces, and whose `--allow-actions`
(or the BrowserTools panel checkbox) permits reload, screenshot, wipe,
settings changes and tab selection.

Add `--verbose` to watch capture as it happens, which is the quickest way to
confirm a fresh install is working:

```bash
npx @agentdeskai/browser-tools-server --verbose
```

Full documentation: https://github.com/AgentDeskAI/browser-tools-mcp
