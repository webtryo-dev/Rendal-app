import prisma from "./db.server";
import type { AdminContext } from "./cofounder/tools.server";
import { PLAN_ORDER, type PlanKey } from "./cofounder/capabilities.server";

// ---------------------------------------------------------------------------
// Keeps shops.plan aligned with what Shopify actually says instead of the
// Prisma column default. Shopify App Pricing stopped sending the
// APP_SUBSCRIPTIONS_UPDATE webhook on 2026-04-28, so plan state is pulled:
// currentAppInstallation.activeSubscriptions is read on app load (ensureShop)
// and on the Usage page, and the plan_handle URL parameter Shopify appends on
// the post-approval redirect is applied immediately (app._index.tsx and
// app.usage.tsx).
// ---------------------------------------------------------------------------

type ShopRow = { id: string; plan: string };

/**
 * Shopify-hosted plan-selection page for this app (Shopify App Pricing).
 * The app handle is the App Store handle from the Partner Dashboard;
 * override with SHOPIFY_APP_HANDLE if it ever differs from "rendal".
 */
export function planSelectionUrl(shopDomain: string): string {
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "rendal";
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

/**
 * Match a Shopify-side plan identifier (an AppSubscription name or a
 * plan_handle redirect parameter) to an internal plan key. Partner Dashboard
 * names and handles are expected to contain the tier word ("Growth",
 * "growth-monthly", …); no internal key is a substring of another, so a
 * contains-match is unambiguous. Returns null for unrecognizable values so
 * callers never rewrite a shop's plan on bad input.
 */
export function mapShopifyPlanToKey(value: string | null | undefined): PlanKey | null {
  const normalized = (value ?? "").toLowerCase();
  if (!normalized) return null;
  return PLAN_ORDER.find((plan) => normalized.includes(plan)) ?? null;
}

// Field names validated against Admin GraphQL 2026-07 (the version pinned in
// shopify.server.ts) via the shopify.dev schema validator.
const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query cofounderActivePlan {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
      }
    }
  }`;

export interface PlanSyncResult<T extends ShopRow> {
  shop: T;
  /** False = Shopify reports no active subscription (e.g. a dev store that
   *  never saw the plan interstitial). Null = lookup failed; nothing known. */
  hasActiveSubscription: boolean | null;
}

/**
 * Read the shop's active subscription from the Admin API and write the mapped
 * plan back to shops.plan when it differs. Best-effort by design: any failure
 * leaves the stored plan untouched rather than blocking the request.
 */
export async function syncPlanFromShopify<T extends ShopRow>(
  shop: T,
  admin: AdminContext,
): Promise<PlanSyncResult<T>> {
  try {
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const json = await response.json();
    const subscriptions: Array<{ name?: string; status?: string }> | undefined =
      json.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subscriptions)) return { shop, hasActiveSubscription: null };

    const active = subscriptions.filter((s) => s?.status === "ACTIVE");
    if (active.length === 0) return { shop, hasActiveSubscription: false };

    const mapped = active.map((s) => mapShopifyPlanToKey(s.name)).find(Boolean);
    if (mapped && mapped !== shop.plan) {
      const updated = await prisma.shops.update({
        where: { id: shop.id },
        data: { plan: mapped, updated_at: new Date() },
      });
      return { shop: { ...shop, ...updated }, hasActiveSubscription: true };
    }
    return { shop, hasActiveSubscription: true };
  } catch {
    return { shop, hasActiveSubscription: null };
  }
}

/**
 * Apply the plan_handle Shopify appends when redirecting the merchant back
 * after a plan change. Persists and returns the mapped key, or null when the
 * handle doesn't correspond to a known plan (nothing is written).
 */
export async function applyPlanHandle(
  shopDomain: string,
  planHandle: string,
): Promise<PlanKey | null> {
  const key = mapShopifyPlanToKey(planHandle);
  if (!key) return null;
  await prisma.shops.upsert({
    where: { shop_domain: shopDomain },
    update: { plan: key, updated_at: new Date() },
    create: { shop_domain: shopDomain, plan: key },
  });
  return key;
}
