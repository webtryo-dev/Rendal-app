import { redirect, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyPlanHandle } from "../plan-sync.server";

// The Rendal chat is the app's home screen.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);

  // Shopify App Pricing appends plan_handle when redirecting the merchant
  // back after a plan change (there is no billing webhook anymore) — apply it
  // now and confirm on the Usage page instead of waiting for the next
  // passive sync.
  const planHandle = url.searchParams.get("plan_handle");
  if (planHandle) {
    const key = await applyPlanHandle(session.shop, planHandle);
    return redirect(key ? `/app/usage?plan_changed=${key}` : "/app/usage");
  }

  return redirect(`/app/cofounder${url.search}`);
};
