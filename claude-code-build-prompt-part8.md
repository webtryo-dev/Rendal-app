## Context (carry forward)
Stack: TypeScript, Shopify React Router app template, Prisma pointed at Supabase Postgres. This app bills merchants through **Shopify App Pricing** (formerly Managed Pricing, renamed May 12, 2026) — not the legacy raw Billing API.

The bug being fixed: `prisma/schema.prisma`'s `shops` model has `plan String @default("starter")`, and `shop.server.ts`'s `ensureShop()` just upserts a shop row with that Prisma default. Nothing anywhere in the codebase actually asks Shopify which plan a merchant selected — every install silently becomes `"starter"` regardless of what the merchant chose (or didn't choose) on Shopify's own hosted pricing screen. Separately, there is currently no way for a merchant to change plans from inside the app.

Two platform facts to design around, both confirmed current as of this session (July 2026):
1. As of April 28, 2026, Shopify stopped sending the `APP_SUBSCRIPTIONS_UPDATE` webhook entirely. Plan state now has to be read on-demand via the GraphQL Admin API's `currentAppInstallation` query (which still exposes active `AppSubscription` objects for the session's shop) rather than pushed to the app via webhook.
2. Shopify requires apps on Shopify App Pricing to let merchants upgrade or downgrade **without contacting support or reinstalling** — this app currently has no such path at all, which is a real App Store compliance gap, not just a UX nicety.

Existing plan-gating logic (`app/cofounder/capabilities.server.ts`: `PLAN_ORDER`, `normalizePlan`, `isModelAllowed`, `isToolAllowed`) already correctly keys off `shop.plan` — it must not be touched. The only thing wrong is that `shop.plan` doesn't reliably reflect what Shopify actually says.

One nuance worth knowing while testing: development stores don't always go through the same billing/plan-selection interstitial a production install does, so seeing `"starter"` by default while testing on a dev store may partly be expected sandbox behavior even after this fix — the fix matters for real merchant installs either way, and dev-store testing should still exercise the sync and upgrade paths described below.

This prompt is 3 phases. Stop and report after each.

## Phase 0 — Verify current API shape before writing any code
Before implementing anything, fetch the current, authoritative field and query names from shopify.dev for: the `currentAppInstallation` query and its `activeSubscriptions` field on the Admin GraphQL API (check the exact field names — `AppSubscription`, `name`, `status`, `lineItems`, etc. — against the current API version this app is pinned to in `shopify.app.toml` / `@shopify/shopify-app-react-router`'s version), and the current mechanism for redirecting merchants to Shopify's hosted plan-selection page and receiving the result back (the `plan_handle` URL parameter behavior introduced alongside the webhook's removal). Do not hardcode any query shape from memory or from this prompt's description — the exact fields available have shifted across recent API versions and must be confirmed against current docs first. Report what you found before proceeding to Phase 1.

## Phase 1 — Sync real plan state from Shopify instead of trusting the DB default
Add a function (e.g. in `shop.server.ts` or a new `plan-sync.server.ts`) that queries `currentAppInstallation.activeSubscriptions` via the authenticated Admin GraphQL client for the current shop, maps the returned subscription's plan name back to this app's internal plan keys (`starter`/`growth`/`scale`/`founder` — match on the plan name string configured in Partner Dashboard, confirm the exact matching approach makes sense given what Phase 0 found), and updates `shop.plan` in Prisma if it differs from what's stored. Call this sync at both of these points: inside `ensureShop()` on every app load (so the DB self-heals on the next visit even without a webhook), and specifically in the loader for `app/routes/app.usage.tsx` (so the Usage page always shows the true current plan, not a stale cached one). If `activeSubscriptions` comes back empty (no plan selected yet, e.g. some dev-store cases), leave `shop.plan` at its existing value but set a flag the Usage page can use to show "No plan selected yet" rather than silently implying Starter was chosen.

## Phase 2 — "Choose a plan" / "Change plan" UI on the Usage page
On `app/routes/app.usage.tsx`, add a plan section showing all four tiers (Starter/Growth/Scale/Founder) with price and the existing feature-matrix bullets already used elsewhere in this project, with the shop's current plan visually marked. Each tier has a button that deep-links the merchant to Shopify's hosted plan-selection/pricing-plan URL for this app (confirm the exact current URL pattern from Phase 0 — do not guess it), pre-selecting that plan where the current API supports it. If no plan is active yet (per the flag from Phase 1), show this section as "Choose a plan to get started" instead of "Change plan." This satisfies Shopify's requirement that merchants can upgrade/downgrade without contacting support or reinstalling — it is a link to Shopify's own hosted flow, not a custom-built billing UI, since Shopify already natively surfaces plan/status/usage/scheduled-downgrade details via the billing card it adds to the merchant's own app-settings page in admin.

## Phase 3 — Handle the return trip
Since there's no webhook anymore, add handling for the `plan_handle` (or whatever Phase 0 confirms is the current parameter name) that Shopify appends when redirecting the merchant back to the app after they complete a plan change on the hosted page. On whichever route receives that redirect (confirm from Phase 0 whether this hits the app's root loader, the auth callback, or a dedicated route), read the parameter, map it to the internal plan key, update `shop.plan` immediately rather than waiting for the next Phase-1 sync, and redirect to the Usage page with a confirmation banner (e.g. "You're now on the Growth plan").
Stop here — end of scope for this prompt.

## Allowed actions
Adding the plan-sync function and its two call sites, editing `app/routes/app.usage.tsx` to add the plan section, adding one new route or extending an existing one to handle the `plan_handle` redirect, reading current docs from shopify.dev.

## Forbidden actions
Do not modify `capabilities.server.ts`'s gating logic, `overage.server.ts`'s ceiling math, or any credit-rate tables — they already correctly key off `shop.plan`, they just need `shop.plan` to be accurate. Do not build a custom in-app billing/checkout UI — link out to Shopify's own hosted plan-selection flow, since Shopify requires billing changes to go through its own system on Shopify App Pricing. Do not guess at GraphQL field names or redirect-parameter names not confirmed in Phase 0. Do not add features beyond what's described here.

## Human review triggers
Stop and ask before: any GraphQL field or query in Phase 0 turns out to require API access this app doesn't currently have (e.g. an API version bump), or if `activeSubscriptions` turns out not to reliably map to a plan name matching this app's four internal plan keys.

## Stop conditions
Treat each phase as a checkpoint. Report what was found (Phase 0) or changed (Phases 1-3) before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
