import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Live turn-status poll. The chat UI hits this every ~750ms while a turn is in
 * flight to render step-by-step progress ("Thinking…", "Searching products…").
 * Deliberately tiny: one indexed read of the shop's current_step, no ensureShop
 * upsert or Admin API call. Returns null on any error (including the column not
 * existing before the manual migration is applied) so polling never breaks chat.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const shop = await prisma.shops.findUnique({
      where: { shop_domain: session.shop },
      select: { current_step: true },
    });
    return { currentStep: shop?.current_step ?? null };
  } catch {
    return { currentStep: null };
  }
};
