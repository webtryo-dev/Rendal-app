import { fetchUrlAsText } from "./webfetch.server";
import type { NeutralToolDef, ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Web research: fetch_url is the one tool that talks to the open internet
// instead of the Shopify Admin API, so it gets its own domain file. The
// SSRF-guarded fetch itself lives in webfetch.server.ts; this file is just
// the tool schema plus the dispatch case.
// ---------------------------------------------------------------------------

export const WEB_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a public web page (https only) and read its text content. Use for research the merchant asks about — competitor pages, suppliers, articles, documentation. Returns readable text, not raw HTML. Cannot access private/internal hosts.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The https:// URL to fetch." },
      },
      required: ["url"],
    },
  },
];

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeWebReadTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "fetch_url": {
      return fetchUrlAsText(String(input.url ?? ""));
    }
    default:
      return null;
  }
}
