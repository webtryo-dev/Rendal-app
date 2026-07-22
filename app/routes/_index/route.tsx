import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

// Public landing page. Installation and login always start from a
// Shopify-owned surface (App Store listing or the admin); this page never
// asks for a shop domain (App Store requirement 2.3.1) — it only forwards
// Shopify-initiated loads that arrive with a shop param.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Rendal — the AI co-founder for your Shopify store</h1>
        <p className={styles.text}>
          Rendal runs inside your Shopify admin. Install it from the Shopify App
          Store, then open it from the <strong>Apps</strong> section of your
          store's admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Store management by chat</strong>. Edit products, inventory,
            discounts, and shipping by asking in plain language.
          </li>
          <li>
            <strong>You approve every change</strong>. Rendal proposes; nothing
            is applied to your store until you confirm it.
          </li>
          <li>
            <strong>Grows with your plan</strong>. Research, analytics, and
            image generation unlock as you scale.
          </li>
        </ul>
      </div>
    </div>
  );
}
