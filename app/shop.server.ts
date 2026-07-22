import prisma from "./db.server";
import type { AdminContext } from "./cofounder/tools.server";
import { syncPlanFromShopify } from "./plan-sync.server";

/**
 * Every persisted record hangs off shops.id. Looked up (or created) on first
 * request from a shop, keyed by the myshopify domain. When an admin context
 * is available, shops.plan is re-synced from Shopify's active subscription
 * (there is no billing webhook anymore, so the DB self-heals on each visit);
 * callers that run their own sync pass skipPlanSync to avoid a second Admin
 * API round-trip. When the shop's email hasn't been captured yet, it is
 * fetched from the Admin API (shop.email) and stored.
 */
export async function ensureShop(
  shopDomain: string,
  admin?: AdminContext,
  options?: { skipPlanSync?: boolean },
) {
  let shop = await prisma.shops.upsert({
    where: { shop_domain: shopDomain },
    update: {},
    create: { shop_domain: shopDomain },
  });

  if (admin && !options?.skipPlanSync) {
    ({ shop } = await syncPlanFromShopify(shop, admin));
  }

  if (!shop.email && admin) {
    try {
      const response = await admin.graphql(`#graphql
        query cofounderShopEmail {
          shop {
            email
          }
        }`);
      const json = await response.json();
      const email = json.data?.shop?.email;
      if (email) {
        return await prisma.shops.update({
          where: { id: shop.id },
          data: { email, updated_at: new Date() },
        });
      }
    } catch {
      // Email capture is best-effort — never block the request on it.
    }
  }
  return shop;
}
