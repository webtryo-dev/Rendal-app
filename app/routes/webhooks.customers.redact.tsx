import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR webhook (customers/redact): erase this app's own records for
// the customer. Payload per shopify.dev:
// { shop_id, shop_domain, customer: { id, email, phone },
//   orders_to_redact: [...] }
// Shopify data itself is never touched — only local rows. deleteMany keeps
// redelivery idempotent. authenticate.webhook returns 401 on invalid HMAC.
type RedactPayload = {
  customer?: { id?: number; email?: string };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const { customer = {} } = payload as RedactPayload;

  // Same lazy-expiry sweep as every other customer_exports access.
  await db.customer_exports.deleteMany({
    where: { expires_at: { lt: new Date() } },
  });

  const shopRow = await db.shops.findUnique({
    where: { shop_domain: shop },
    select: { id: true },
  });

  // Exports are whole-file CSV snapshots the merchant can regenerate, so any
  // live export referencing the customer is deleted outright rather than
  // edited row-by-row.
  if (shopRow && (customer.id || customer.email)) {
    const { count } = await db.customer_exports.deleteMany({
      where: {
        shop_id: shopRow.id,
        OR: [
          ...(customer.id
            ? [{ data: { contains: `gid://shopify/Customer/${customer.id}` } }]
            : []),
          ...(customer.email
            ? [
                {
                  data: {
                    contains: customer.email,
                    mode: "insensitive" as const,
                  },
                },
              ]
            : []),
        ],
      },
    });
    console.log(
      `customers/redact for ${shop}: deleted ${count} export(s) referencing the customer`,
    );
  }

  return new Response();
};
