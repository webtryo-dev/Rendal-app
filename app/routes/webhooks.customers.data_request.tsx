import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR webhook (customers/data_request): the merchant must be able
// to pass the customer their data. Payload per shopify.dev:
// { shop_id, shop_domain, orders_requested: [...],
//   customer: { id, email, phone }, data_request: { id } }
// A 200 acknowledges receipt; the merchant-facing follow-up is manual.
// authenticate.webhook returns 401 on invalid HMAC, as the docs require.
type DataRequestPayload = {
  customer?: { id?: number; email?: string };
  data_request?: { id?: number };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const { customer = {}, data_request: dataRequest = {} } =
    payload as DataRequestPayload;

  // Same lazy-expiry sweep as every other customer_exports access.
  await db.customer_exports.deleteMany({
    where: { expires_at: { lt: new Date() } },
  });

  const shopRow = await db.shops.findUnique({
    where: { shop_domain: shop },
    select: { id: true },
  });

  // The only per-customer data this app holds is transient customer CSV
  // exports. Surface which live exports contain this customer so the request
  // can be answered — ids/filenames only, never the CSV contents or the
  // customer's identifiers.
  let matches: { id: string; filename: string }[] = [];
  if (shopRow && (customer.id || customer.email)) {
    matches = await db.customer_exports.findMany({
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
      select: { id: true, filename: true },
    });
  }

  console.log(
    `customers/data_request ${dataRequest.id ?? "(no id)"} for ${shop}: ` +
      (matches.length
        ? `customer appears in ${matches.length} live export(s): ` +
          matches.map((m) => `${m.filename} [${m.id}]`).join(", ")
        : "no stored data held for this customer"),
  );

  return new Response();
};
