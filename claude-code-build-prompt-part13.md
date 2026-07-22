## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. Three things reported, all grounded in real code/logs from earlier work in this project:

1. **Same grant-screen redirect failure as before.** Shopify's automated check again lands post-install on `https://admin.shopify.com/store/.../app/grant?action=...` instead of the app homepage. This was already root-caused: `shopify.app.toml` had `redirect_urls = ["https://app.rendal.io/api/auth"]`, but the app's actual OAuth callback (per `authPathPrefix: "/auth"` in `shopify.server.ts`) is `/auth/callback` — a live test previously confirmed `https://app.rendal.io/api/auth` returns 404. If this is still failing, either that fix was never applied, or it was applied to the toml but never pushed to Partner Dashboard via `shopify app deploy` (editing the toml alone does not update Shopify's registered redirect URL).
2. **Plan selection still doesn't redirect anywhere.** Already root-caused separately: `app/routes/app.usage.tsx`'s `goToPlanSelection` does `window.location.assign("/app/usage?intent=choose_plan")`, a bare URL missing `embedded=1`/`host`/`shop`. The Shopify SDK's redirect helper (`node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/admin/helpers/redirect.js`) only takes the correct iframe-escape path when the current request looks embedded (`isEmbeddedRequest` checks for `embedded=1`); without it, the loader's `shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" })` call falls through to a plain redirect that can't jump the iframe to `admin.shopify.com`. Server logs previously confirmed this exact symptom: `GET /app/usage?intent=choose_plan 200` in ~4-7ms, far faster than a real Usage load, meaning the escape never happens.
3. **New requirement: force plan selection before Chat, right after install.** Today, `app/routes/app._index.tsx`'s loader redirects straight to `/app/cofounder` (the homepage is Chat). The request now: on first landing after install (and any time the shop has no active Shopify App Pricing subscription), redirect the merchant straight to Shopify's hosted plan-selection page — not to Chat, and not merely to a "choose a plan" section on the Usage page that requires an extra click. Only after a plan is actually chosen should the merchant land on Chat.

Existing building blocks already in the codebase to reuse, not rebuild: `app/plan-sync.server.ts`'s `syncPlanFromShopify(shop, admin)` (returns `hasActiveSubscription: boolean | null`), `applyPlanHandle(shopDomain, planHandle)`, `planSelectionUrl(shop)`, `mapShopifyPlanToKey`. `app/routes/app.usage.tsx` already demonstrates the correct embedded-escape call pattern: `const { admin, session, redirect: shopifyRedirect } = await authenticate.admin(request); ... shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" })`.

If Part 10's route-level gate (redirecting `/app/*` routes to `/app/usage` when no plan is selected, added to `app/routes/app.tsx`'s loader) is already in place, keep it as a defensive fallback — this prompt adds an earlier interception at the true entry point, it doesn't replace that gate.

This prompt is 4 phases. Stop and report after each.

## Phase 1 — Re-verify and fix the redirect_urls mismatch
Read the current `redirect_urls` value in `shopify.app.toml`. If it's still `https://app.rendal.io/api/auth` (or anything other than the correct callback path matching `authPathPrefix: "/auth"`), fix it to `https://app.rendal.io/auth/callback` — confirm the exact expected path against the installed `@shopify/shopify-app-react-router` version's docs before writing it. After fixing, run this app's deploy command (check `package.json` scripts — likely `shopify app deploy`) so Partner Dashboard's registered redirect URL actually updates; a toml edit alone does not take effect on Shopify's side. Confirm in Partner Dashboard (or via the CLI) that the redirect URL shown now matches.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Fix `goToPlanSelection`'s missing embedded context
In `app/routes/app.usage.tsx`, change `goToPlanSelection` so the navigation URL keeps the current page's existing query parameters (`embedded`, `host`, `shop`, and anything else `window.location.search` already contains) and adds `intent=choose_plan` on top, instead of discarding everything. Confirm against `isEmbeddedRequest` in the SDK's `redirect.js` that the resulting request now correctly evaluates as embedded, so `shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" })` takes the real iframe-escape path. Reproduce on a dev store: click a plan button, confirm it actually lands on Shopify's hosted plan page (not a bare 200/blank response).
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Force plan selection before Chat, right after install
In `app/routes/app._index.tsx`'s loader, after the existing `plan_handle` handling block, and before the final `return redirect(\`/app/cofounder${url.search}\`)`, add a check: call `syncPlanFromShopify` (via `ensureShop(session.shop, admin, { skipPlanSync: true })` then `syncPlanFromShopify(shop, admin)`, the same two-call pattern `app.usage.tsx` already uses) and, if `hasActiveSubscription === false` (explicitly false, not null — a failed lookup must never block access), use the same embedded-escape redirect used in `app.usage.tsx`: `const { redirect: shopifyRedirect } = await authenticate.admin(request); return shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" });`. Preserve the current request's embedded query params on this call the same way Phase 2 fixed `goToPlanSelection`, since this is the same iframe-escape mechanism and needs the same context to work. If `hasActiveSubscription` is `true` or `null`, fall through to the existing `/app/cofounder` redirect unchanged.
Stop here and wait for confirmation before continuing to Phase 4.

## Phase 4 — Land on Chat after choosing a plan, and verify end to end
Currently, after a plan is chosen, `app._index.tsx`'s `plan_handle` handling redirects to `/app/usage?plan_changed=<key>`. Change this so it redirects to `/app/cofounder?plan_changed=<key>` instead, so the merchant lands on Chat, not Usage. If reasonably scoped, carry the "You're now on the X plan" confirmation banner over to the Chat page using the same `plan_changed` query param and `mapShopifyPlanToKey`/`planConfig` helpers `app.usage.tsx` already uses — reuse that logic rather than duplicating it; if it doesn't fit cleanly without meaningfully restructuring `app.cofounder.tsx`, it's fine to skip the banner and just land on a normal Chat view, report that tradeoff rather than forcing it in.

Then reproduce the full flow on a dev store: install (or reinstall) the app, confirm it redirects straight to Shopify's hosted plan-selection page (not Chat, not a "choose a plan" click-through), choose a plan, confirm the return trip lands on Chat (not a bare "200" or blank page), and confirm a shop that already has an active plan still goes straight to Chat as before without ever seeing the plan page. Check server logs to confirm each hop's actual status code.
Stop here — end of scope for this prompt.

## Allowed actions
Reading/editing `shopify.app.toml`, running the app's deploy command, editing `app/routes/app.usage.tsx` (Phase 2), editing `app/routes/app._index.tsx` (Phases 3-4), reading server/deployment logs, testing on a dev store.

## Forbidden actions
Do not touch `app/routes/app.tsx`'s existing route-gate logic from earlier work (if present) — this prompt adds an earlier interception, not a replacement. Do not change `capabilities.server.ts`'s gating logic, `overage.server.ts`'s ceiling math, or billing/credit tables. Do not treat `hasActiveSubscription === null` as equivalent to `false` anywhere — a failed lookup must never block or redirect a merchant away from the app. Do not guess at the SDK's exact callback path or embedded-request detection — verify both against actual installed-package source/docs as already demonstrated in this project.

## Human review triggers
Stop and ask if Phase 1 finds `redirect_urls` was already correct (meaning the grant-screen failure has a different cause than previously diagnosed) — don't re-apply a fix that isn't needed without first explaining what you found instead. Stop and ask if forcing the Phase 3 redirect on every no-plan visit creates a redirect loop with any other loader (e.g. Part 10's route gate, if present).

## Stop conditions
Treat each of the 4 phases as its own checkpoint. Report what was found or changed after each one before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
