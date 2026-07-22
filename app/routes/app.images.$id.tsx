import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../shop.server";

// Resource route (loader only, no component) that streams a generated image's
// bytes to the embedded admin. Scoped to the owning shop so one store can never
// read another's generated images. Requests are made from the chat UI via the
// App Bridge-authenticated fetch, so the session token reaches authenticate.admin.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin);

  const id = params.id ?? "";
  const image = await prisma.generated_images.findFirst({
    where: { id, shop_id: shop.id },
    select: { data: true, mime_type: true },
  });
  if (!image) {
    throw new Response("Image not found", { status: 404 });
  }

  const bytes = Buffer.from(image.data, "base64");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": image.mime_type,
      "Content-Length": String(bytes.length),
      // Private: only the authenticated merchant should ever see this.
      "Cache-Control": "private, max-age=3600",
    },
  });
};
