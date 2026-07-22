import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../shop.server";

// Resource route (loader only) that streams a customer CSV export to the
// embedded admin as a file download. Scoped to the owning shop, and enforces
// the 24h expiry: expired rows are swept on access and never served. Requests
// come from the chat UI via the App Bridge-authenticated fetch.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin);

  // Lazy expiry: drop anything past its window before serving.
  await prisma.customer_exports.deleteMany({ where: { expires_at: { lt: new Date() } } });

  const id = params.id ?? "";
  const exportRow = await prisma.customer_exports.findFirst({
    where: { id, shop_id: shop.id },
    select: { data: true, filename: true, expires_at: true },
  });
  if (!exportRow || exportRow.expires_at.getTime() < Date.now()) {
    throw new Response("Export not found or expired", { status: 404 });
  }

  const bytes = Buffer.from(exportRow.data, "utf8");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportRow.filename}"`,
      "Content-Length": String(bytes.length),
      // Sensitive PII — never cache in the browser or any shared cache.
      "Cache-Control": "no-store",
    },
  });
};
