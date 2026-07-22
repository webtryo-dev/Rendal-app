import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../shop.server";
import { getOverageStatus, rolloverBillingPeriod } from "../cofounder/overage.server";
import { planConfig } from "../cofounder/pricing.server";

// Read-only display of numbers pricing.server.ts and overage.server.ts already
// compute — no billing logic lives here. Advancing the billing period (if one
// has elapsed) mirrors what the chat action does, so the figures shown reflect
// the current period.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  let shop = await ensureShop(session.shop, admin);
  shop = await rolloverBillingPeriod(shop);

  const cfg = planConfig(shop.plan);
  const overage = await getOverageStatus(shop);

  const includedCredits = Number(cfg.includedCredits);
  const remainingCredits = Math.max(0, Number(shop.credit_balance));

  return {
    planLabel: cfg.label,
    planPriceUsd: cfg.priceUsd,
    includedCredits,
    remainingCredits,
    usedCredits: Math.max(0, includedCredits - remainingCredits),
    overageDollars: overage.overageDollars,
    ceilingUsd: overage.ceilingUsd,
    blocked: overage.blocked,
    resumesAt: overage.resumesAt.toISOString(),
  };
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
  const resetDate = new Date(data.resumesAt).toLocaleDateString(undefined, { dateStyle: "medium" });

  const creditsFraction =
    data.includedCredits > 0 ? data.remainingCredits / data.includedCredits : 0;
  const overageFraction = data.ceilingUsd > 0 ? data.overageDollars / data.ceilingUsd : 0;

  return (
    <s-page heading="Usage">
      <s-stack direction="block" gap="base">
        {/* Plan */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-heading>Current plan</s-heading>
              <s-badge size="base">{data.planLabel}</s-badge>
            </s-stack>
            <s-text color="subdued">{`${money(data.planPriceUsd)} / month`}</s-text>
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
