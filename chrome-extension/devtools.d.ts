interface Settings {
  logLimit: number;
  queryLimit: number;
  stringSizeLimit: number;
  maxLogSize: number;
  showRequestHeaders: boolean;
  showResponseHeaders: boolean;
  screenshotPath: string;
  serverHost: string;
  serverPort: number;
  allowAutoPaste: boolean;
}

interface LogData {
  type: string;
  message: any;
  timestamp: number;
  source?: string;
  level?: string;
}

declare function truncateStringsInData(
  data: any,
  maxLength: number,
  depth?: number,
  path?: string
): any;
declare function calculateObjectSize(obj: any): number;
declare function processArrayWithSizeLimit(
  array: any[],
  maxTotalSize: number,
  processFunc: (item: any) => any
): any[];
declare function processJsonString(
  jsonString: string,
  maxLength: number
): string;
declare function sendToBrowserConnector(logData: LogData): Promise<void>;
declare function validateServerIdentity(): Promise<boolean>;
declare function wipeLogs(): void;
declare function attachDebugger(): Promise<void>;
declare function performAttach(): Promise<void>;
declare function detachDebugger(): void;
declare function captureAndSendElement(): Promise<void>;
declare function sendHeartbeat(): void;
declare function setupWebSocket(): Promise<void>;

declare const consoleMessageListener: (
  source: string,
  method: string,
  params: any
) => void;
