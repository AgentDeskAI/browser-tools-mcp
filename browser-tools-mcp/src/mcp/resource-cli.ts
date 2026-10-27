import type { ConnectorClient } from "./client.js";
import { buildHar } from "../util/har.js";
import { scopeToOptions } from "./resources.js";

export const ALL_RESOURCE_COMMANDS = [
  "console-history",
  "network-history",
  "network-har",
  "screenshot",
  "audit-report",
] as const;

export type ResourceCommandName = (typeof ALL_RESOURCE_COMMANDS)[number];

export async function fetchResource(
  name: ResourceCommandName,
  client: ConnectorClient,
  scope: string
): Promise<unknown> {
  switch (name) {
    case "console-history":
      return client.exportConsole(scopeToOptions(scope));
    case "network-history":
      return client.exportNetwork(scopeToOptions(scope));
    case "network-har": {
      const exported = await client.exportNetwork(scopeToOptions(scope));
      return buildHar(exported.entries);
    }
    case "screenshot": {
      const artifact = await client.readArtifact("screenshot", decodeURIComponent(scope));
      return {
        mimeType: artifact.mimeType,
        ...(artifact.blob !== undefined ? { blob: artifact.blob } : { text: artifact.text ?? "" }),
      };
    }
    case "audit-report": {
      const artifact = await client.readArtifact("audit", decodeURIComponent(scope));
      return artifact.text ? JSON.parse(artifact.text) : null;
    }
    default:
      throw new Error(`Unknown resource: ${name satisfies never}`);
  }
}
