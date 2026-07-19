import { redirect, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// The Rendal chat is the app's home screen.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/cofounder${url.search}`);
};
