import { diffLines } from "./diff.server";
import type { DiffLine } from "./types";
import {
  POLICY_SCOPE_MESSAGE,
  graphqlJson,
  type AdminContext,
  type NeutralToolDef,
  type ToolExecution,
} from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Shop insight tools: ShopifyQL analytics and general shop info, plus the
// approval-gated policy write. update_shop_policies lives here because
// get_shop_info is its read counterpart — it surfaces the current policy text
// the model must read before proposing a replacement. Schemas and
// implementations live together; the barrel (tools.server.ts) aggregates and
// dispatches. All GraphQL validated against the 2026-07 Admin schema.
// ---------------------------------------------------------------------------

export const ANALYTICS_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: "read_analytics",
    description:
      "Query the store's aggregated analytics — sales, orders, traffic/sessions, and conversion rate — using ShopifyQL. Read-only; results are aggregates, not raw customer records. Pass one ShopifyQL query string.\n" +
      "Syntax: FROM <dataset> SHOW <metrics> [ GROUP BY <dimensions> ] [ TIMESERIES <hour|day|week|month> ] [ WHERE <filter> ] [ SINCE <start> UNTIL <end> ] [ ORDER BY <field> [ASC|DESC] ] [ LIMIT <n> ].\n" +
      "Datasets: `sales` (metrics: total_sales, gross_sales, net_sales, orders, ordered_item_quantity, average_order_value, returns; dimensions: product_title, sales_channel, billing_region, …) and `sessions` (metrics: sessions, visitors; used for traffic and conversion rate). Dates accept today, yesterday, relative offsets like -7d/-30d/-3m/-1y, or ISO dates (2026-06-01).\n" +
      'Examples: "FROM sales SHOW total_sales, orders TIMESERIES day SINCE -30d UNTIL today" · "FROM sales SHOW total_sales GROUP BY product_title ORDER BY total_sales DESC LIMIT 10 SINCE -90d" · "FROM sessions SHOW sessions TIMESERIES day SINCE -30d".\n' +
      "If the result includes parse errors, read them and correct the query, then call again. Breakdowns that expose individual customer data may require a pending Shopify data-access approval.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'A single ShopifyQL query string, e.g. "FROM sales SHOW total_sales TIMESERIES month SINCE -3m UNTIL today".',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_shop_info",
    description:
      "Read general store settings and info: shop name, contact email, domains, currency, timezone, weight unit, Shopify plan, and the current legal policy text (refund, privacy, shipping, terms of service). Read-only. Call this before proposing a policy change so you can see the existing text.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_shop_policies",
    description:
      "Propose replacing the full text of one of the store's legal policies — refund, privacy, shipping, or terms of service. The merchant reviews a before/after diff and must approve before it is saved. This REPLACES the entire policy body (HTML allowed); it does not append. Read the current text with get_shop_info first, then pass the COMPLETE new policy text.",
    inputSchema: {
      type: "object",
      properties: {
        policyType: {
          type: "string",
          enum: ["refund", "privacy", "shipping", "terms"],
          description: "Which policy to update.",
        },
        body: {
          type: "string",
          description: "The complete new policy text (HTML allowed). Replaces the existing policy entirely.",
        },
      },
      required: ["policyType", "body"],
    },
  },
];

export const ANALYTICS_WRITE_TOOL_NAMES = ["update_shop_policies"];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

// ShopifyQL over the Admin API (validated 2026-07 against shopify.dev). The
// return type is a flat object — tableData.columns + tableData.rows — not the
// older TableResponse/PolarisVizResponse union. Requires the read_reports scope.
const SHOPIFYQL_QUERY = `#graphql
  query cofounderShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }`;

// Shop settings + legal policies (validated 2026-07). shopPolicyUpdate needs
// the write_legal_policies scope; the read below needs no extra scope.
const GET_SHOP_INFO_QUERY = `#graphql
  query cofounderGetShopInfo {
    shop {
      name
      email
      contactEmail
      myshopifyDomain
      primaryDomain { url host }
      currencyCode
      ianaTimezone
      weightUnit
      plan { publicDisplayName partnerDevelopment shopifyPlus }
      shopPolicies { type title url body }
    }
  }`;

const GET_SHOP_POLICIES_QUERY = `#graphql
  query cofounderGetShopPolicies {
    shop {
      shopPolicies { type body }
    }
  }`;

const SHOP_POLICY_UPDATE_MUTATION = `#graphql
  mutation cofounderShopPolicyUpdate($shopPolicy: ShopPolicyInput!) {
    shopPolicyUpdate(shopPolicy: $shopPolicy) {
      shopPolicy { id type url }
      userErrors { field message code }
    }
  }`;

// Merchant-facing policy names map to the ShopPolicyType enum expected by
// shopPolicyUpdate. Only the four policies in scope for this app are exposed.
const POLICY_TYPE_MAP: Record<string, string> = {
  refund: "REFUND_POLICY",
  privacy: "PRIVACY_POLICY",
  shipping: "SHIPPING_POLICY",
  terms: "TERMS_OF_SERVICE",
};
const POLICY_LABELS: Record<string, string> = {
  refund: "Refund policy",
  privacy: "Privacy policy",
  shipping: "Shipping policy",
  terms: "Terms of service",
};

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeAnalyticsReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "read_analytics": {
      const json = await graphqlJson(admin, SHOPIFYQL_QUERY, {
        query: String(input.query ?? ""),
      });
      const resp = json.data?.shopifyqlQuery;
      if (!resp) {
        return { content: "No analytics response was returned.", isError: true };
      }
      const parseErrors: string[] = resp.parseErrors ?? [];
      if (parseErrors.length > 0) {
        const joined = parseErrors.join(" | ");
        // A permission/PCD failure surfaced as a parse error gets the same
        // one-line explanation as the thrown-error path below.
        if (/protected|not approved|permission|access denied|unauthorized/i.test(joined)) {
          return {
            content:
              "Detailed analytics require a pending Shopify data-access approval, so that data isn't available yet.",
            isError: true,
          };
        }
        return {
          content: `The analytics query couldn't be parsed: ${joined}. Adjust the ShopifyQL and try again.`,
          isError: true,
        };
      }
      const table = resp.tableData;
      if (!table || !table.columns) {
        return { content: "The query ran but returned no data.", isError: false };
      }
      return {
        content: JSON.stringify({ columns: table.columns, rows: table.rows ?? [] }),
        isError: false,
      };
    }
    case "get_shop_info": {
      const json = await graphqlJson(admin, GET_SHOP_INFO_QUERY);
      const shop = json.data?.shop;
      if (!shop) {
        return { content: "Could not read shop info.", isError: true };
      }
      // Policy bodies can be large — cap each so a huge policy can't blow the
      // model's context. The merchant can still open the policy in the admin.
      const policies = (shop.shopPolicies ?? []).map(
        (p: { type: string; title?: string; url?: string; body?: string }) => ({
          type: p.type,
          title: p.title,
          url: p.url,
          body:
            typeof p.body === "string" && p.body.length > 4000
              ? `${p.body.slice(0, 4000)}… (truncated — ${p.body.length} chars total)`
              : p.body,
        }),
      );
      return { content: JSON.stringify({ ...shop, shopPolicies: policies }), isError: false };
    }
    default:
      return null;
  }
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeAnalyticsWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "update_shop_policies": {
      const type = POLICY_TYPE_MAP[String(input.policyType ?? "")];
      if (!type) {
        return {
          content: `Unknown policy type "${input.policyType}". Use refund, privacy, shipping, or terms.`,
          isError: true,
        };
      }
      const json = await graphqlJson(admin, SHOP_POLICY_UPDATE_MUTATION, {
        shopPolicy: { type, body: String(input.body ?? "") },
      });
      const userErrors = json.data?.shopPolicyUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const joined = JSON.stringify(userErrors);
        if (/write_legal_policies|access denied|unauthorized|not approved/i.test(joined)) {
          return { content: POLICY_SCOPE_MESSAGE, isError: true };
        }
        return { content: `Policy update failed: ${joined}`, isError: true };
      }
      const policy = json.data?.shopPolicyUpdate?.shopPolicy;
      return {
        content: `Policy updated (${policy?.type ?? type}): ${JSON.stringify(policy)}`,
        isError: false,
      };
    }
    default:
      return null;
  }
}

/**
 * Approval-card data for update_shop_policies: fetches the current policy text
 * from the Admin API and builds a real before/after diff (same review UX as
 * theme edits), so the merchant sees exactly what changes before a full-text
 * replacement is saved.
 */
export async function prepareShopPolicyWrite(
  admin: AdminContext,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; diff?: DiffLine[]; warning?: string }> {
  const policyKey = String(input.policyType ?? "");
  const type = POLICY_TYPE_MAP[policyKey];
  const label = POLICY_LABELS[policyKey] ?? policyKey;
  const newBody = String(input.body ?? "");
  if (!type) {
    return {
      summary: [`Update policy "${policyKey}"`, "Unknown policy type — use refund, privacy, shipping, or terms."],
      warning: "Unknown policy type.",
    };
  }
  const json = await graphqlJson(admin, GET_SHOP_POLICIES_QUERY);
  const policies: { type: string; body?: string }[] = json.data?.shop?.shopPolicies ?? [];
  const current = policies.find((p) => p.type === type);
  const currentBody = current?.body ?? "";
  return {
    summary: [
      `Update the ${label}`,
      "This replaces the entire policy text.",
      ...(current ? [] : ["No existing text for this policy — it will be created."]),
    ],
    diff: currentBody
      ? diffLines(currentBody, newBody)
      : newBody.split(/\r?\n/).map((text) => ({ type: "add" as const, text })),
  };
}
