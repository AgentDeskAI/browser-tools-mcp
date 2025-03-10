# Browser Tools Server

A powerful browser tools server for capturing and managing browser events, logs, and screenshots. This server works in conjunction with the Browser Tools Chrome Extension to provide comprehensive browser debugging capabilities.

## Features

- Console log capture
- Network request monitoring
- Screenshot capture
- Element selection tracking
- Browser storage access (cookies, localStorage, sessionStorage)
- WebSocket real-time communication
- Configurable log limits and settings

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
npx @agentdeskai/browser-tools-server
```

2. The server will start on port 3025 by default

3. Install and enable the Browser Tools Chrome Extension

4. The server exposes the following endpoints:

- `/console-logs` - Get console logs
- `/console-errors` - Get console errors
- `/network-errors` - Get network error logs
- `/network-success` - Get successful network requests
- `/all-xhr` - Get all network requests
- `/screenshot` - Capture screenshots
- `/selected-element` - Get currently selected DOM element
- `/cookies` - Get cookies from the current page
- `/local-storage` - Get localStorage data
- `/session-storage` - Get sessionStorage data

## API Documentation

### GET Endpoints

- `GET /console-logs` - Returns recent console logs
- `GET /console-errors` - Returns recent console errors
- `GET /network-errors` - Returns recent network errors
- `GET /network-success` - Returns recent successful network requests
- `GET /all-xhr` - Returns all recent network requests
- `GET /selected-element` - Returns the currently selected DOM element
- `GET /cookies` - Returns cookies from the current page
- `GET /local-storage` - Returns localStorage data
- `GET /session-storage` - Returns sessionStorage data

### POST Endpoints

- `POST /extension-log` - Receive logs from the extension
- `POST /screenshot` - Capture and save screenshots
- `POST /selected-element` - Update the selected element
- `POST /wipelogs` - Clear all stored logs

## License

MIT
