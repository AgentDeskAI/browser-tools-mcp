interface MessageResponse {
  success: boolean;
  url?: string;
  error?: string;
}

interface UpdateServerUrlMessage {
  type: 'UPDATE_SERVER_URL';
  tabId: number;
  url: string;
  source?: string;
}

interface GetCurrentUrlMessage {
  type: 'GET_CURRENT_URL';
  tabId: number;
}

type Message = UpdateServerUrlMessage | GetCurrentUrlMessage;

declare function validateServerIdentity(
  host: string,
  port: number
): Promise<boolean>;
declare function processTabForAudit(tab: chrome.tabs.Tab, tabId: number): void;
declare function getCurrentTabUrl(tabId: number): Promise<string>;
declare function updateServerWithUrl(
  tabId: number,
  url: string,
  source?: string
): Promise<void>;
declare function retestConnectionOnRefresh(tabId: number): Promise<void>;
declare function captureAndSendScreenshot(
  message: { tabId: number; format?: string },
  settings: { host: string; port: number },
  sendResponse: (response: MessageResponse) => void
): void;
