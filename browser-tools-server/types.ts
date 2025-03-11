// Base log type for all logs
export interface BaseLog {
  type: string;
  timestamp: number;
}

// Console log types
export interface ConsoleLog extends BaseLog {
  type: 'console-log';
  level: string;
  message: string;
}

export interface ConsoleError extends BaseLog {
  type: 'console-error';
  level: 'error';
  message: string;
}

// Network request type
export interface NetworkRequest extends BaseLog {
  type: 'network-request';
  url: string;
  method: string;
  status: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

// Screenshot related types
export interface ScreenshotCallback {
  resolve: (value: {
    data: string;
    path?: string;
    autoPaste?: boolean;
  }) => void;
  reject: (reason: Error) => void;
}

export interface ScreenshotMessage {
  type: 'screenshot-data' | 'screenshot-error';
  data?: string;
  path?: string;
  error?: string;
  autoPaste?: boolean;
}

// Settings type
export interface BrowserConnectorSettings {
  logLimit: number;
  queryLimit: number;
  showRequestHeaders: boolean;
  showResponseHeaders: boolean;
  model: string;
  stringSizeLimit: number;
  maxLogSize: number;
  screenshotPath: string;
  serverHost: string;
}

// Selected element type
export interface SelectedElement {
  tagName?: string;
  id?: string;
  className?: string;
  [key: string]: any;
}
