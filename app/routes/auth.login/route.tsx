import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// The manual shop-domain login form was removed (App Store requirement 2.3.1:
// apps must not ask merchants to type a myshopify.com domain). Installation
// and login start from the App Store listing or the Shopify admin, which
// arrive with a shop param and never touch this route; anything that still
// lands here goes to the public landing page.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return redirect("/");
};
