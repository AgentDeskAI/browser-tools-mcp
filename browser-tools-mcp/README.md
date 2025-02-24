# Browser Tools MCP Server

A Model Context Protocol (MCP) server that provides AI-powered browser tools integration. This server works in conjunction with the Browser Tools Server to provide AI capabilities for browser debugging and analysis.

## Features

- MCP protocol implementation
- Browser console log access
- Network request analysis
- Screenshot capture capabilities
- Element selection and inspection
- Real-time browser state monitoring

## Installation

```bash
npx @agentdeskai/browser-tools-mcp
```

Or install globally:

```bash
npm install -g @agentdeskai/browser-tools-mcp
```

## Usage

1. First, make sure the Browser Tools Server is running:

```bash
# Default port (3025)
npx @agentdeskai/browser-tools-server

# Or with custom port
MCP_PORT=3030 npx @agentdeskai/browser-tools-server
```

2. Then start the MCP server:

```bash
npx @agentdeskai/browser-tools-mcp
```

3. Configure the Chrome Extension:
   - Open Chrome DevTools (F12 or Cmd+Option+I)
   - Select the "BrowserToolsMCP" panel
   - In the Connection Settings section, set the Server Port if needed (default is 3025)

4. The MCP server will connect to the Browser Tools Server and provide the following capabilities:

- Console log retrieval
- Network request monitoring
- Screenshot capture
- Element selection
- Browser state analysis

## MCP Functions

The server provides the following MCP functions:

- `mcp_getConsoleLogs` - Retrieve browser console logs
- `mcp_getConsoleErrors` - Get browser console errors
- `mcp_getNetworkErrors` - Get network error logs
- `mcp_getNetworkSuccess` - Get successful network requests
- `mcp_getNetworkLogs` - Get all network logs
- `mcp_getSelectedElement` - Get the currently selected DOM element

## Integration

This server is designed to work with AI tools and platforms that support the Model Context Protocol (MCP). It provides a standardized interface for AI models to interact with browser state and debugging information.

## License

MIT
