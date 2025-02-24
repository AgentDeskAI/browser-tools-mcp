# Browser Tools Server

A powerful browser tools server for capturing and managing browser events, logs, and screenshots. This server works in conjunction with the Browser Tools Chrome Extension to provide comprehensive browser debugging capabilities.

## Features

- Console log capture
- Network request monitoring
- Screenshot capture
- Element selection tracking
- WebSocket real-time communication
- Configurable log limits and settings
- Configurable server port via environment variable

## Installation

```bash
npx @agentdeskai/browser-tools-server
```

Or install globally:

```bash
npm install -g @agentdeskai/browser-tools-server
```

## Usage

1. Start the server:

```bash
# Default port (3025)
npx @agentdeskai/browser-tools-server

# Custom port
MCP_PORT=3030 npx @agentdeskai/browser-tools-server
```

2. The server will start on port 3025 by default. You can configure the port using the `MCP_PORT` environment variable.

   **Important:** If you change the server port, you must also update the port in the Browser Tools Chrome Extension settings to match. Both the server and extension must use the same port to communicate.

3. Install and enable the Browser Tools Chrome Extension
   - Open Chrome DevTools (F12 or Cmd+Option+I)
   - Select the "BrowserToolsMCP" panel
   - In the Connection Settings section, set the Server Port if needed (default is 3025)

4. The server exposes the following endpoints:

- `/console-logs` - Get console logs
- `/console-errors` - Get console errors
- `/network-errors` - Get network error logs
- `/network-success` - Get successful network requests
- `/all-xhr` - Get all network requests
- `/screenshot` - Capture screenshots
- `/selected-element` - Get currently selected DOM element

## API Documentation

### GET Endpoints

- `GET /console-logs` - Returns recent console logs
- `GET /console-errors` - Returns recent console errors
- `GET /network-errors` - Returns recent network errors
- `GET /network-success` - Returns recent successful network requests
- `GET /all-xhr` - Returns all recent network requests
- `GET /selected-element` - Returns the currently selected DOM element

### POST Endpoints

- `POST /extension-log` - Receive logs from the extension
- `POST /screenshot` - Capture and save screenshots
- `POST /selected-element` - Update the selected element
- `POST /wipelogs` - Clear all stored logs

## License

MIT
