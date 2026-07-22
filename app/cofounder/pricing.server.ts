// ---------------------------------------------------------------------------
// Single source of truth for plan pricing, included credits, and the
// self-enforced overage ceilings. Plans themselves are configured in the
// Shopify Partner Dashboard (Shopify App Pricing); these values mirror that
// configuration and MUST be kept in sync with it.
// ---------------------------------------------------------------------------

/** Retail rate: credits per $1 of subscription/overage price. */
export const RETAIL_CREDITS_PER_DOLLAR = 50_000;

/** Markup over real API cost. */
export const MARKUP_MULTIPLIER = 5;

/** Credits deducted per $1 of real API cost (= retail rate x markup). */
export const REAL_COST_CREDIT_RATE = RETAIL_CREDITS_PER_DOLLAR * MARKUP_MULTIPLIER; // 250,000

/** Partner Dashboard meter: "Extra credits", flat rate $0.00002/unit. */
export const EXTRA_CREDIT_METER_HANDLE = "extra_credit_usage";

/** App Events API endpoints (REST — see shopify.dev/docs/api/app-events). */
export const APP_EVENTS_URL = "https://api.shopify.com/app/unstable/events";
export const APP_EVENTS_AUTH_URL = "https://api.shopify.com/auth/access_token";

export interface PlanConfig {
  label: string;
  priceUsd: number;
  includedCredits: bigint;
  /** Self-enforced max overage dollars billable per billing period. */
  overageCeilingUsd: number;
}

export const PLANS: Record<string, PlanConfig> = {
  starter: { label: "Starter", priceUsd: 19.99, includedCredits: 999_500n, overageCeilingUsd: 40 },
  growth: { label: "Growth", priceUsd: 49.99, includedCredits: 2_499_500n, overageCeilingUsd: 100 },
  scale: { label: "Scale", priceUsd: 149.99, includedCredits: 7_499_500n, overageCeilingUsd: 300 },
  founder: { label: "Founder", priceUsd: 299.99, includedCredits: 14_999_500n, overageCeilingUsd: 600 },
};

/** Unknown/legacy plan values fall back to the most conservative tier. */
export function planConfig(plan: string): PlanConfig {
  return PLANS[plan] ?? PLANS.starter;
}
