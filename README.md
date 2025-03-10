# BrowserTools MCP

> Make your AI tools 10x more aware and capable of interacting with your browser

This application is a powerful browser monitoring and interaction tool that enables AI-powered applications via Anthropic's Model Context Protocol (MCP) to capture and analyze browser data through a Chrome extension.

Read our [docs](https://browsertools.agentdesk.ai/) for the full installation, quickstart and contribution guides.

## Architecture

There are three core components all used to capture and analyze browser data:

1. **Chrome Extension**: A browser extension that captures screenshots, console logs, network activity, DOM elements, and browser storage (cookies, localStorage, sessionStorage).
2. **Node Server**: An intermediary server that facilitates communication between the Chrome extension and any instance of an MCP server.
3. **MCP Server**: A Model Context Protocol server that provides standardized tools for AI clients to interact with the browser.

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌─────────────┐
│  MCP Client │ ──► │  MCP Server  │ ──► │  Node Server  │ ──► │   Chrome    │
│  (e.g.      │ ◄── │  (Protocol   │ ◄── │ (Middleware)  │ ◄── │  Extension  │
│   Cursor)   │     │   Handler)   │     │               │     │             │
└─────────────┘     └──────────────┘     └───────────────┘     └─────────────┘
```

Model Context Protocol (MCP) is a capability supported by Anthropic AI models that
allow you to create custom tools for any compatible client. MCP clients like Claude
Desktop, Cursor, Cline or Zed can run an MCP server which "teaches" these clients
about a new tool that they can use.

These tools can call out to external APIs but in our case, **all logs are stored locally** on your machine and NEVER sent out to any third-party service or API. BrowserTools MCP runs a local instance of a NodeJS API server which communicates with the BrowserTools Chrome Extension.

All consumers of the BrowserTools MCP Server interface with the same NodeJS API and Chrome extension.

#### Chrome Extension

- Monitors XHR requests/responses and console logs
- Tracks selected DOM elements
- Sends all logs and current element to the BrowserTools Connector
- Connects to Websocket server to capture/send screenshots
- Retrieves cookies, localStorage, and sessionStorage data
- Allows user to configure token/truncation limits + screenshot folder path

#### Node Server

- Acts as middleware between the Chrome extension and MCP server
- Receives logs and currently selected element from Chrome extension
- Processes requests from MCP server to capture logs, screenshot or current element
- Retrieves browser storage data (cookies, localStorage, sessionStorage)
- Sends Websocket command to the Chrome extension for capturing a screenshot
- Intelligently truncates strings and # of duplicate objects in logs to avoid token limits
- Removes cookies and sensitive headers to avoid sending to LLMs in MCP clients

#### MCP Server

- Implements the Model Context Protocol
- Provides standardized tools for AI clients
- Compatible with various MCP clients (Cursor, Cline, Zed, Claude Desktop, etc.)

## Installation

Installation steps can be found in our documentation:

- [BrowserTools MCP Docs](https://browsertools.agentdesk.ai/)

## Usage

Once installed and configured, the system allows any compatible MCP client to:

- Monitor browser console output
- Capture network traffic
- Take screenshots
- Analyze selected elements
- Access browser storage (cookies, localStorage, sessionStorage)
- Wipe logs stored in our MCP server

## Compatibility

- Works with any MCP-compatible client
- Primarily designed for Cursor IDE integration
- Supports other AI editors and MCP clients
