import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// fetch_url — read-only web fetch for the chat model.
//
// Hard limits: HTTPS only, 10s timeout, 2MB response cap, redirects followed
// manually (each hop re-validated), and every hostname resolved and checked
// against private/internal IP ranges before connecting (SSRF guard).
// Failures come back as one-line messages, never stack traces.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Cap on text handed back to the model, so one page can't flood context. */
const MAX_RETURN_CHARS = 40_000;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 192 && b === 0) || // 192.0.0.0/24 special-use
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice(7);
      return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
    }
    return (
      lower.startsWith("fc") || // unique local fc00::/7
      lower.startsWith("fd") ||
      lower.startsWith("fe8") || // link-local fe80::/10
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }
  return true; // not a valid IP literal — treat as blocked when used as one
}

/** Validate scheme + resolve the host, rejecting private/internal targets. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Only https:// URLs can be fetched.");
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Blocked host: ${host} is not a public address.`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked host: ${host} is a private address.`);
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}.`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`Blocked host: ${host} resolves to a private address.`);
  }
  return url;
}

/** Read the body with a hard byte cap; abort the stream past the cap. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds the ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
};

/** Strip HTML to readable text: drop script/style, keep block structure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FetchResult {
  content: string;
  isError: boolean;
}

export async function fetchUrlAsText(rawUrl: string): Promise<FetchResult> {
  try {
    let url = await assertSafeUrl(rawUrl);

    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": "Rendal-Shopify-App/1.0 (+https://app.rendal.io)", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { content: `Fetch failed: redirect from ${url.hostname} had no target.`, isError: true };
        if (hop === MAX_REDIRECTS) return { content: `Fetch failed: too many redirects (max ${MAX_REDIRECTS}).`, isError: true };
        // Re-validate every hop — a public page must not bounce us internal.
        url = await assertSafeUrl(new URL(location, url).toString());
        continue;
      }
      break;
    }
    if (!response) return { content: "Fetch failed: no response.", isError: true };
    if (!response.ok) {
      return { content: `Fetch failed: ${url.hostname} responded with HTTP ${response.status}.`, isError: true };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isTexty =
      contentType.includes("text/") ||
      contentType.includes("application/json") ||
      contentType.includes("application/xml") ||
      contentType.includes("+xml") ||
      contentType.includes("+json");
    if (!isTexty) {
      return { content: `Fetch failed: unsupported content type "${contentType || "unknown"}" (only text pages can be read).`, isError: true };
    }

    const body = await readCapped(response);
    const text = contentType.includes("text/html") ? htmlToText(body) : body.trim();
    if (!text) return { content: `Fetched ${url.toString()} but the page had no readable text.`, isError: true };

    const truncated = text.length > MAX_RETURN_CHARS;
    return {
      content:
        `Content of ${url.toString()}:\n\n${text.slice(0, MAX_RETURN_CHARS)}` +
        (truncated ? "\n\n[Truncated — page text exceeded the return limit.]" : ""),
      isError: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) {
      return { content: `Fetch failed: ${rawUrl} timed out after ${TIMEOUT_MS / 1000}s.`, isError: true };
    }
    return { content: `Fetch failed: ${message}`, isError: true };
  }
}
