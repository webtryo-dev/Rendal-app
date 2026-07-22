import type { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// Shared infrastructure for the per-domain tool files (*.tools.server.ts):
// the neutral tool-definition shape, the GraphQL helper, and the friendly
// error mapping. Domain files import from here; nothing here imports a domain
// file, so there are no cycles. The aggregate tool list and dispatchers live
// in tools.server.ts (the barrel).
// ---------------------------------------------------------------------------

export type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

export interface NeutralToolDef {
  name: string;
  description: string;
  /** Plain JSON Schema (object type) for the tool input. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolExecution {
  content: string;
  isError: boolean;
}

/**
 * Publishing a theme needs a manual Shopify per-app exemption on top of the
 * write_themes scope — not fixable in code. When themePublish is refused for
 * that reason (thrown ACCESS_DENIED or a userError), the merchant gets this
 * one-liner instead of a raw error, mirroring the Protected Customer Data path.
 */
export const THEME_EXEMPTION_MESSAGE =
  "Publishing themes requires a one-time Shopify API exemption for this app, which hasn't been granted yet — so the live theme wasn't changed. You can request it in the Shopify Partner Dashboard.";

export function isThemeExemptionError(text: string): boolean {
  return /exemption|access denied|unauthorized|not authorized|not approved|write_themes/i.test(text);
}

/** Shown when shopPolicyUpdate is refused for lack of the write_legal_policies scope. */
export const POLICY_SCOPE_MESSAGE =
  "Updating store policies needs the write_legal_policies permission, which hasn't been granted to this app yet. Re-installing the app to accept the updated permissions will enable it.";

/**
 * Map a failed tool call to a merchant-readable message. Actual customer PII
 * (email/phone/name/address) is gated behind Shopify's "Protected customer
 * data access" manual review in the Partner Dashboard — not addable via
 * scopes in code — so that specific denial gets a one-line explanation
 * instead of a raw access-denied error. Everything else surfaces verbatim.
 */
export function friendlyToolError(name: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if ((name === "publish_theme" || name === "unpublish_theme") && isThemeExemptionError(raw)) {
    return THEME_EXEMPTION_MESSAGE;
  }
  if (
    name === "update_shop_policies" &&
    /write_legal_policies|access denied|unauthorized|not approved/i.test(raw)
  ) {
    return POLICY_SCOPE_MESSAGE;
  }
  // Analytics access is gated by the read_reports scope and, for
  // customer-linked breakdowns, Shopify's Protected Customer Data (level 2)
  // review — neither is fixable in code. Same one-liner treatment as PII below.
  if (
    name === "read_analytics" &&
    /protected customer data|not approved|access denied|unauthorized|read_reports|permission/i.test(raw)
  ) {
    return "Detailed analytics require a pending Shopify data-access approval, so that data isn't available yet.";
  }
  if (/protected customer data|not approved to access|customer.*not approved/i.test(raw)) {
    return "Customer contact details require a pending Shopify approval (Protected customer data access), so that information isn't available yet.";
  }
  return `Tool ${name} failed: ${raw}`;
}

export async function graphqlJson(
  admin: AdminContext,
  query: string,
  variables?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await response.json();
  // Surface top-level GraphQL errors (e.g. ACCESS_DENIED) — they arrive
  // alongside null data, not in userErrors, and must never look like success.
  const errors = (json as { errors?: { message: string }[] }).errors;
  if (errors && errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(" | "));
  }
  return json;
}
