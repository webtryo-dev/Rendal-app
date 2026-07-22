import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../shop.server";
import { getOverageStatus, rolloverBillingPeriod } from "../cofounder/overage.server";
import { planConfig, PLANS } from "../cofounder/pricing.server";
import { normalizePlan, PLAN_ORDER, type PlanKey } from "../cofounder/capabilities.server";
import {
  applyPlanHandle,
  mapShopifyPlanToKey,
  planSelectionUrl,
  syncPlanFromShopify,
} from "../plan-sync.server";

// Read-only display of numbers pricing.server.ts and overage.server.ts already
// compute — no billing logic lives here. Advancing the billing period (if one
// has elapsed) mirrors what the chat action does, so the figures shown reflect
// the current period. The plan itself is re-read from Shopify on every load
// (Shopify App Pricing sends no webhooks), and plan changes link out to
// Shopify's hosted plan-selection page — no custom billing UI.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect: shopifyRedirect } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Fallback for old links only: the plan buttons now navigate the top window
  // directly (see goToPlanSelection below), because this server hop only
  // escapes the iframe when the document request still carries embedded=1 —
  // and SPA navigation strips those params from the iframe URL.
  if (url.searchParams.get("intent") === "choose_plan") {
    return shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" });
  }

  // Shopify App Pricing appends plan_handle on the post-approval redirect.
  // The app root handles the default return trip; this covers per-plan
  // welcome links pointed directly at the Usage page.
  const planHandle = url.searchParams.get("plan_handle");
  if (planHandle) {
    const key = await applyPlanHandle(session.shop, planHandle);
    return redirect(key ? `/app/usage?plan_changed=${key}` : "/app/usage");
  }

  let shop = await ensureShop(session.shop, admin, { skipPlanSync: true });
  const sync = await syncPlanFromShopify(shop, admin);
  shop = await rolloverBillingPeriod(sync.shop);

  const cfg = planConfig(shop.plan);
  const overage = await getOverageStatus(shop);

  const includedCredits = Number(cfg.includedCredits);
  const remainingCredits = Math.max(0, Number(shop.credit_balance));

  // False only when Shopify positively reported "no active subscription"
  // (e.g. a dev store that skipped the plan interstitial) — a failed lookup
  // keeps the stored plan and stays quiet.
  const noPlanSelected = sync.hasActiveSubscription === false;
  const currentPlan = normalizePlan(shop.plan);
  const changedKey = mapShopifyPlanToKey(url.searchParams.get("plan_changed"));

  return {
    planUrl: planSelectionUrl(session.shop),
    planLabel: cfg.label,
    planPriceUsd: cfg.priceUsd,
    includedCredits,
    remainingCredits,
    usedCredits: Math.max(0, includedCredits - remainingCredits),
    overageDollars: overage.overageDollars,
    ceilingUsd: overage.ceilingUsd,
    blocked: overage.blocked,
    resumesAt: overage.resumesAt.toISOString(),
    noPlanSelected,
    planChangedLabel: changedKey ? planConfig(changedKey).label : null,
    tiers: PLAN_ORDER.map((key) => ({
      key,
      label: PLANS[key].label,
      priceUsd: PLANS[key].priceUsd,
      includedCredits: Number(PLANS[key].includedCredits),
      isCurrent: !noPlanSelected && key === currentPlan,
    })),
  };
};

// UI mirror of the plan feature matrix (capabilities.server.ts is the map
// that actually gates access; DESIGN.md holds the model-tier table).
const PLAN_FEATURES: Record<PlanKey, string[]> = {
  starter: [
    "Standard AI models",
    "Product, inventory & theme editing",
    "Percentage-off discount codes",
    "Web research",
  ],
  growth: [
    "Everything in Starter",
    "Full discount suite (BXGY, free shipping)",
    "Shipping zones & rates",
  ],
  scale: [
    "Everything in Growth",
    "Premium AI models",
    "AI image generation",
    "Analytics & customer exports",
  ],
  founder: [
    "Everything in Scale",
    "Flagship AI models",
    "Theme publishing",
    "Store policy updates",
  ],
};

function Bar({ fraction, color }: { fraction: number; color: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      style={{
        width: "100%",
        height: 8,
        borderRadius: 4,
        background: "rgba(128,128,128,0.2)",
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

export default function UsagePage() {
  const data = useLoaderData<typeof loader>();

  // Navigate the top window straight to Shopify's hosted plan page (managed
  // pricing). Deliberately not a server round-trip: SPA navigation strips the
  // embedded=1/host/shop params from the iframe URL, so a document request to
  // our own loader can't reliably take the iframe-escape path. window.open
  // with "_top" from a click handler is the documented App Bridge way out.
  const goToPlanSelection = () => {
    window.open(data.planUrl, "_top");
  };
  const resetDate = new Date(data.resumesAt).toLocaleDateString(undefined, { dateStyle: "medium" });

  const creditsFraction =
    data.includedCredits > 0 ? data.remainingCredits / data.includedCredits : 0;
  const overageFraction = data.ceilingUsd > 0 ? data.overageDollars / data.ceilingUsd : 0;

  return (
    <s-page heading="Usage">
      <s-stack direction="block" gap="base">
        {data.planChangedLabel && (
          <s-banner tone="success" dismissible>
            {`You're now on the ${data.planChangedLabel} plan.`}
          </s-banner>
        )}

        {/* Plan */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-heading>Current plan</s-heading>
              {data.noPlanSelected ? (
                <s-badge tone="warning">No plan selected yet</s-badge>
              ) : (
                <s-badge size="base">{data.planLabel}</s-badge>
              )}
            </s-stack>
            {data.noPlanSelected ? (
              <s-text color="subdued">
                Choose a plan below to get started — until then, limits shown here follow the
                Starter tier.
              </s-text>
            ) : (
              <s-text color="subdued">{`${money(data.planPriceUsd)} / month`}</s-text>
            )}
          </s-stack>
        </s-section>

        {/* Choose / change plan */}
        <s-section>
          <s-stack direction="block" gap="base">
            <s-heading>
              {data.noPlanSelected ? "Choose a plan to get started" : "Change plan"}
            </s-heading>
            <s-text color="subdued">
              Plan changes are handled by Shopify — any button below opens the plan page in your
              admin, where you can upgrade or downgrade at any time.
            </s-text>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              {data.tiers.map((tier) => (
                <div
                  key={tier.key}
                  style={{
                    border: tier.isCurrent
                      ? "2px solid #2e7d32"
                      : "1px solid rgba(128,128,128,0.35)",
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <s-stack direction="block" gap="small-300">
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      <s-heading>{tier.label}</s-heading>
                      {tier.isCurrent && <s-badge tone="success">Current plan</s-badge>}
                    </s-stack>
                    <s-text>{`${money(tier.priceUsd)} / month`}</s-text>
                    <s-text color="subdued">
                      {`${tier.includedCredits.toLocaleString()} credits included`}
                    </s-text>
                    {PLAN_FEATURES[tier.key].map((feature) => (
                      <s-text key={feature} color="subdued">{`• ${feature}`}</s-text>
                    ))}
                    <s-button
                      variant={tier.isCurrent ? "secondary" : "primary"}
                      disabled={tier.isCurrent || undefined}
                      onClick={goToPlanSelection}
                    >
                      {tier.isCurrent
                        ? "Current plan"
                        : data.noPlanSelected
                          ? `Choose ${tier.label}`
                          : `Switch to ${tier.label}`}
                    </s-button>
                  </s-stack>
                </div>
              ))}
            </div>
          </s-stack>
        </s-section>

        {/* Included credits */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-heading>Included credits</s-heading>
            <Bar fraction={creditsFraction} color="#2e7d32" />
            <s-text>
              {`${data.remainingCredits.toLocaleString()} of ${data.includedCredits.toLocaleString()} credits remaining`}
            </s-text>
            <s-text color="subdued">
              {`${data.usedCredits.toLocaleString()} used this billing period`}
            </s-text>
          </s-stack>
        </s-section>

        {/* Extra usage (overage) */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-heading>Extra usage this period</s-heading>
            <Bar fraction={overageFraction} color={data.blocked ? "#c62828" : "#f9a825"} />
            <s-text>
              {`${money(data.overageDollars)} of ${money(data.ceilingUsd)} extra-usage allowance used`}
            </s-text>
            <s-text color="subdued">
              Extra usage is billed only after your included credits run out, up to this
              per-period limit.
            </s-text>
            {data.blocked && (
              <s-banner tone="critical">
                {`You've reached this period's extra-usage limit. Standard usage resumes on ${resetDate}. Upgrading your plan raises the limit right away.`}
              </s-banner>
            )}
          </s-stack>
        </s-section>

        {/* Reset */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-heading>Billing period</s-heading>
            <s-text>{`Credits and extra-usage reset on ${resetDate}.`}</s-text>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
