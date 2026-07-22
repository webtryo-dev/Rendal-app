// ---------------------------------------------------------------------------
// Single source of truth for what each plan UNLOCKS: the highest model tier it
// may use, and the set of tools it may call. This is the access map only — it
// says nothing about price, included credits, or overage (those live in
// pricing.server.ts and MUST NOT be touched by gating). See DESIGN.md
// "Model catalog & tiers" and the Rendal credits-and-billing feature matrix.
//
// Enforcement is server-side (see app.cofounder.tsx for models and
// cofounder.server.ts for tools). The UI may mirror this map for convenience,
// but the checks here are the only thing that actually gates access.
// ---------------------------------------------------------------------------

import type { ModelTier } from "./types";

/** Plans from least to most inclusive. Unknown/legacy plans fall back to the
 *  first (most conservative) entry, mirroring pricing.server.ts#planConfig. */
export const PLAN_ORDER = ["starter", "growth", "scale", "founder"] as const;
export type PlanKey = (typeof PLAN_ORDER)[number];

/** A plan unlocks every model tier up to and including its ceiling. */
const MODEL_TIER_RANK: Record<ModelTier, number> = {
  standard: 0,
  premium: 1,
  flagship: 2,
};

/**
 * Highest model tier each plan may run. Growth adds full model *switching* but
 * stays within the standard tier — premium is Scale+, flagship is Founder only.
 */
export const PLAN_MODEL_CEILING: Record<PlanKey, ModelTier> = {
  starter: "standard",
  growth: "standard",
  scale: "premium",
  founder: "flagship",
};

/**
 * Tools each plan ADDS on top of the plan below it (mirrors the feature
 * matrix's "adds ..." language). Names are matched against the tool `name`
 * fields in tools.server.ts. A name may be listed here before its executor
 * exists — the map is intentionally forward-compatible — but nothing here
 * imports or calls a tool function, so an unbuilt tool is harmless.
 */
const TOOLS_ADDED_BY_PLAN: Record<PlanKey, string[]> = {
  // Starter — the core set every plan gets. These are the original core tools
  // plus the create/delete product tools, fetch_url, and the shop/discount
  // reads. ("Skills" in the matrix is a separate feature, not a chat tool, so
  // it is not represented here.)
  starter: [
    // product read + create/edit/delete
    "search_products",
    "get_product",
    "create_product",
    "update_product",
    "delete_product",
    // inventory
    "get_inventory_levels",
    "set_inventory_quantity",
    // basic discounts (percentage-off) + read
    "list_discounts",
    "create_discount_code",
    // shipping read
    "get_shipping_setup",
    // theme reads (advisory only — theme writes aren't offered; App Store
    // requirement 5.1.1 forbids Theme API modification without an exemption)
    "list_themes",
    "list_theme_files",
    "read_theme_file",
    // general shop read + web research
    "get_shop_info",
    "fetch_url",
  ],

  // Growth — shipping zone/rate tools + the full discount suite.
  growth: [
    "create_shipping_zone",
    "update_shipping_zone",
    "set_shipping_rate",
    "create_bxgy_discount",
    "create_free_shipping_discount",
    "update_discount_code",
    "deactivate_discount_code",
    "delete_discount_code",
  ],

  // Scale — image tools, the analytics tool, and customer list/CSV.
  scale: [
    "generate_image",
    "upload_image_to_files",
    "read_analytics",
    "list_customers",
    "generate_customer_csv",
  ],

  // Founder — store-policy edits. (Theme publish/unpublish lived here until
  // the theme write tools were removed for App Store requirement 5.1.1.)
  //
  // NOTE: the "Automation email (connected ESP)" capability from the feature
  // matrix is intentionally omitted for now — no such tool exists yet. When it
  // lands, add its real tool name here to gate it to Founder.
  founder: ["update_shop_policies"],
};

/** Cumulative allowed-tool set per plan (each plan inherits everything below). */
const PLAN_TOOLS: Record<PlanKey, Set<string>> = (() => {
  const result = {} as Record<PlanKey, Set<string>>;
  const cumulative = new Set<string>();
  for (const plan of PLAN_ORDER) {
    for (const tool of TOOLS_ADDED_BY_PLAN[plan]) cumulative.add(tool);
    result[plan] = new Set(cumulative);
  }
  return result;
})();

/** Coerce any plan string to a known plan, defaulting to the safest tier. */
export function normalizePlan(plan: string | null | undefined): PlanKey {
  return (PLAN_ORDER as readonly string[]).includes(plan ?? "")
    ? (plan as PlanKey)
    : "starter";
}

/** True when `plan` may run a model of the given tier. */
export function isModelAllowed(plan: string, modelTier: ModelTier): boolean {
  const ceiling = PLAN_MODEL_CEILING[normalizePlan(plan)];
  return MODEL_TIER_RANK[modelTier] <= MODEL_TIER_RANK[ceiling];
}

/** True when `plan` may call the tool. Unknown tool names are denied. */
export function isToolAllowed(plan: string, toolName: string): boolean {
  return PLAN_TOOLS[normalizePlan(plan)].has(toolName);
}

/** The lowest plan whose ceiling reaches this model tier (for upgrade hints). */
export function requiredPlanForModelTier(modelTier: ModelTier): PlanKey {
  for (const plan of PLAN_ORDER) {
    if (MODEL_TIER_RANK[modelTier] <= MODEL_TIER_RANK[PLAN_MODEL_CEILING[plan]]) {
      return plan;
    }
  }
  return "founder";
}

/** The lowest plan that unlocks this tool, or null if it isn't in the map. */
export function requiredPlanForTool(toolName: string): PlanKey | null {
  for (const plan of PLAN_ORDER) {
    if (PLAN_TOOLS[plan].has(toolName)) return plan;
  }
  return null;
}
