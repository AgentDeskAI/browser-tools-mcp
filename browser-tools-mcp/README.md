# Browser Tools MCP Server

A Model Context Protocol (MCP) server that provides AI-powered browser tools integration. This server works in conjunction with the Browser Tools Server to provide AI capabilities for browser debugging and analysis.

## Features

- MCP protocol implementation
- Browser console log access
- Network request analysis
- Screenshot capture capabilities
- Element selection and inspection
- Real-time browser state monitoring
- Accessibility, performance, SEO, and best practices audits

## Prerequisites

- Node.js 14 or higher
- Browser Tools Server running
- Chrome or Chromium browser installed (required for audit functionality)

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
npx @agentdeskai/browser-tools-server
```

2. Then start the MCP server:

```bash
npx @agentdeskai/browser-tools-mcp
```

3. The MCP server will connect to the Browser Tools Server and provide the following capabilities:

- Console log retrieval
- Network request monitoring
- Screenshot capture
- Element selection
- Browser state analysis
- Accessibility and performance audits

## MCP Functions

The server provides the following MCP functions:

- `mcp_getConsoleLogs` - Retrieve browser console logs
- `mcp_getConsoleErrors` - Get browser console errors
- `mcp_getNetworkErrors` - Get network error logs
- `mcp_getNetworkSuccess` - Get successful network requests
- `mcp_getNetworkLogs` - Get all network logs
- `mcp_getSelectedElement` - Get the currently selected DOM element
- `mcp_runAccessibilityAudit` - Run a WCAG-compliant accessibility audit
- `mcp_runPerformanceAudit` - Run a performance audit
- `mcp_runSEOAudit` - Run an SEO audit
- `mcp_runBestPracticesAudit` - Run a best practices audit

## Integration

This server is designed to work with AI tools and platforms that support the Model Context Protocol (MCP). It provides a standardized interface for AI models to interact with browser state and debugging information.

## License

MIT
