import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR webhook (shop/redact): sent 48 hours after uninstall.
// Payload per shopify.dev: { shop_id, shop_domain }. Purges every row this
// app keys to the shop. Children are deleted before parents inside one
// transaction so the purge never depends on DB-level cascade config (these
// tables were created by hand-applied SQL). deleteMany keeps redelivery
// idempotent. authenticate.webhook returns 401 on invalid HMAC.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRow = await db.shops.findUnique({
    where: { shop_domain: shop },
    select: { id: true },
  });

  if (shopRow) {
    const shopId = shopRow.id;
    const results = await db.$transaction([
      db.credit_ledger.deleteMany({ where: { shop_id: shopId } }),
      db.chat_messages.deleteMany({ where: { chats: { shop_id: shopId } } }),
      db.chats.deleteMany({ where: { shop_id: shopId } }),
      db.customer_exports.deleteMany({ where: { shop_id: shopId } }),
      db.generated_images.deleteMany({ where: { shop_id: shopId } }),
      db.mcp_connections.deleteMany({ where: { shop_id: shopId } }),
      db.skills.deleteMany({ where: { shop_id: shopId } }),
      db.usage_logs.deleteMany({ where: { shop_id: shopId } }),
      db.shops.deleteMany({ where: { id: shopId } }),
    ]);
    const total = results.reduce((sum, r) => sum + r.count, 0);
    console.log(`shop/redact for ${shop}: purged ${total} row(s)`);
  }

  // Sessions and the legacy Skill/McpServer tables key on the domain string
  // rather than shops.id.
  await db.session.deleteMany({ where: { shop } });
  await db.skill.deleteMany({ where: { shop } });
  await db.mcpServer.deleteMany({ where: { shop } });

  return new Response();
};
