## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. Shopify's automated App Store review just failed this app on two independent points:

1. **Broken install redirect.** The check landed the merchant on `https://admin.shopify.com/store/appstoretest9/app/grant?...` instead of the app homepage after installation. Root cause already confirmed by direct testing: `shopify.app.toml` has `redirect_urls = ["https://app.rendal.io/api/auth"]`, but `app/shopify.server.ts` sets `authPathPrefix: "/auth"`, meaning the app's real OAuth callback route is `/auth/callback`, not `/api/auth`. Live test confirmed `https://app.rendal.io/api/auth` returns 404. Shopify redirects the merchant to a route that doesn't exist, so the flow never completes. Also confirmed but NOT yet root-caused: hitting `https://app.rendal.io/auth/callback` and `https://app.rendal.io/auth?shop=test.myshopify.com` directly both return HTTP 410 — unexpected, needs investigation (check Render deployment logs and routing config, and whether 410 is coming from the app itself or from Render's edge/static-file handling).
2. **Missing mandatory compliance webhooks.** `shopify.app.toml`'s `[webhooks]` section only registers `app/uninstalled` and `app/scopes_update`. The three legally required GDPR topics — `customers/data_request`, `customers/redact`, `shop/redact` — are not registered anywhere and have no route handlers in `app/routes/`. This app has never had these built.

Existing webhook handler pattern to follow: `app/routes/webhooks.app.uninstalled.tsx` and `app/routes/webhooks.app.scopes_update.tsx` — read both before writing new ones, since Shopify's webhook signature verification and response format must match exactly.

Relevant existing PII-handling context: the `customer_exports` Prisma table already has a lazy-expiry design ("held only long enough for..., expired lazily on access and on each new export, never logged") from earlier work — the redact handlers should integrate with this, not duplicate a separate erasure mechanism.

This prompt is 3 phases. Stop and report after each.

## Phase 1 — Fix the redirect_urls mismatch and diagnose the 410s
Fix `shopify.app.toml`'s `redirect_urls` to the correct callback path matching `authPathPrefix: "/auth"` (`https://app.rendal.io/auth/callback` — confirm the exact expected callback path against the installed `@shopify/shopify-app-react-router` version's docs before writing it, do not assume). After fixing, this config change alone doesn't take effect on Shopify's side until pushed — run whatever the current deploy command is (check `package.json` scripts, likely `shopify app deploy` or `npm run deploy`) so Partner Dashboard's registered redirect URL actually updates, and confirm it shows correctly there.

Separately, investigate why direct requests to `/auth/callback` and `/auth?shop=...` return HTTP 410 instead of a redirect to Shopify's OAuth authorize screen or a meaningful error. Check: whether this status is coming from the app's own code (grep for any `410` or `Response` with that status in the auth-related files) versus the Render deployment's routing/rewrite config versus the `@shopify/shopify-app-react-router` package's own error handling for malformed or missing embedded-session context. Report the root cause before fixing it — don't guess-patch it.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Build the three mandatory compliance webhooks
Add `[[webhooks.subscriptions]]` entries to `shopify.app.toml` for `customers/data_request`, `customers/redact`, and `shop/redact`, each pointing at a new route file following the existing naming convention (`webhooks.customers.data_request.tsx`, `webhooks.customers.redact.tsx`, `webhooks.shop.redact.tsx`). Before writing the handlers, check shopify.dev's current mandatory-webhooks documentation for the exact expected payload shape and response contract for each of the three topics — these are legal/compliance requirements and must not be guessed from memory.
- `customers/data_request`: look up what data this app holds tied to the given customer id (in `customer_exports` and anywhere else customer data may be referenced) and log or expose it per Shopify's documented process for responding to the request — this app does not need to auto-email the data unless the docs require it, but must acknowledge and handle the payload correctly.
- `customers/redact`: purge any `customer_exports` rows and other stored data tied to the given customer id from this app's own database. Do not attempt to alter or redact anything in Shopify's own systems — only this app's local records.
- `shop/redact`: Shopify sends this ~48 hours after uninstall (confirm exact timing from current docs). Purge all shop-scoped data for the given shop from this app's database (the `shops` row, related `customer_exports`, chat history, skills, usage records — whatever tables key off `shop_id` in the current schema).
All three handlers must verify the webhook HMAC using the same pattern as the existing `webhooks.app.uninstalled.tsx` handler and return the response format Shopify's mandatory webhook docs specify.
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Verify end to end
After both fixes are deployed, confirm: `https://app.rendal.io/auth/callback` no longer 404s or returns an unexplained 410 (redirects to Shopify OAuth as expected), Partner Dashboard shows the corrected redirect URL and all five webhook subscriptions (the original two plus the three new ones), and each new webhook route responds correctly to a manually simulated test payload if the current Shopify CLI or docs provide a way to do that safely in a dev environment.
Stop here — end of scope for this prompt.

## Allowed actions
Editing `shopify.app.toml`'s `redirect_urls` and `[webhooks]` section, adding the three new webhook route files, running the app's deploy command, reading Render deployment logs/config if accessible, reading shopify.dev docs for exact payload/response contracts.

## Forbidden actions
Do not alter the existing `app/uninstalled` or `app/scopes_update` webhook handlers beyond using them as a reference pattern. Do not guess at the mandatory webhook payload shape, response contract, or `shop/redact` timing — confirm against current shopify.dev docs first. Do not build any customer-facing UI or email for `customers/data_request` unless the docs specifically require an automated response beyond acknowledgment. Do not touch unrelated routes, the plan-gating logic, or billing code.

## Human review triggers
Stop and ask before: deleting any production data as part of testing `shop/redact` or `customers/redact` locally, or if the 410 root cause in Phase 1 turns out to require a Render configuration change you can't verify directly.

## Stop conditions
Treat each phase as its own checkpoint. Report what was found or changed after each one before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
