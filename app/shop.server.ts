import prisma from "./db.server";
import type { AdminContext } from "./cofounder/tools.server";

/**
 * Every persisted record hangs off shops.id. Looked up (or created) on first
 * request from a shop, keyed by the myshopify domain. When an admin context
 * is available and the shop's email hasn't been captured yet, it is fetched
 * from the Admin API (shop.email) and stored.
 */
export async function ensureShop(shopDomain: string, admin?: AdminContext) {
  const shop = await prisma.shops.upsert({
    where: { shop_domain: shopDomain },
    update: {},
    create: { shop_domain: shopDomain },
  });

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
