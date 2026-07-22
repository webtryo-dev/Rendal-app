import { redirect, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../shop.server";
import { applyPlanHandle, planSelectionUrl, syncPlanFromShopify } from "../plan-sync.server";

// The Rendal chat is the app's home screen.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect: shopifyRedirect } = await authenticate.admin(request);

  const url = new URL(request.url);

  // Shopify App Pricing appends plan_handle when redirecting the merchant
  // back after a plan change (there is no billing webhook anymore) — apply it
  // now and land on Chat, which confirms the change. The rest of the query
  // string (embedded, host, shop) must survive the hop: this is a document
  // request, and without those params App Bridge can't boot on the next page.
  const planHandle = url.searchParams.get("plan_handle");
  if (planHandle) {
    const key = await applyPlanHandle(session.shop, planHandle);
    const params = new URLSearchParams(url.search);
    params.delete("plan_handle");
    if (key) params.set("plan_changed", key);
    const search = params.toString();
    return redirect(`/app/cofounder${search ? `?${search}` : ""}`);
  }

  // No active Shopify App Pricing subscription → straight to Shopify's hosted
  // plan-selection page, before Chat ever loads. This entry request comes from
  // the admin iframe load and still carries embedded=1/host/shop, so the
  // package's "_top" redirect can escape the iframe (the reason app.usage.tsx's
  // buttons can't rely on this same server hop after SPA navigation). Only an
  // explicit false blocks: null means the lookup failed, and a failed lookup
  // must never lock a merchant out of the app.
  const shop = await ensureShop(session.shop, admin, { skipPlanSync: true });
  const sync = await syncPlanFromShopify(shop, admin);
  if (sync.hasActiveSubscription === false) {
    return shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" });
  }

  return redirect(`/app/cofounder${url.search}`);
};
