## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. Reported bug: clicking any plan button (Founder or any other tier) on `app/routes/app.usage.tsx` leads to a page that just displays the literal text "200" instead of the expected Shopify hosted plan-selection page or a working return trip back to Usage.

Root cause identified via direct inspection of `node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/admin/helpers/redirect.js`: this SDK's `redirect()` helper (destructured as `shopifyRedirect` in `app.usage.tsx`'s loader) picks its escape strategy based on whether the *current incoming request* looks embedded — specifically `isEmbeddedRequest(request)` checks for `embedded=1` in the request URL's query string. Only when that's true (or the request is a same-origin `_self` target, or a data request with a session-token header) does it correctly throw the `renderAppBridge` HTML response (a small page that does `window.open(url, "_top")` to truly escape the iframe to `admin.shopify.com`'s pricing page). Otherwise it silently falls through to a plain `reactRouter.redirect(url, init)` — an ordinary same-response 302, which cannot reliably move a nested iframe to a different top-level origin.

`app.usage.tsx`'s `goToPlanSelection` function currently does:
```js
const goToPlanSelection = () => {
  window.location.assign("/app/usage?intent=choose_plan");
};
```
This constructs a bare URL with none of the embedded context params the original page load had (`embedded=1`, `host`, `shop`, `id_token`, etc. — the same params `redirect.js`'s own `embeddedFrameParamsToRemove` list shows the SDK normally expects to see and strips when constructing admin-remote-path redirects). Because `embedded=1` is missing from this constructed URL, `isEmbeddedRequest(request)` evaluates false when the loader's `shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" })` call runs, so the correct iframe-escape path never fires.

This prompt is 2 phases. Stop and report after each.

## Phase 1 — Fix `goToPlanSelection` to preserve embedded context
Change `goToPlanSelection` in `app/routes/app.usage.tsx` so the navigation URL keeps the current page's existing query parameters (at minimum `embedded`, `host`, `shop` — whatever the current `window.location.search` already contains) and adds `intent=choose_plan` on top, rather than discarding everything. Read the current `window.location.search`, parse it, add/overwrite `intent=choose_plan`, and navigate to the resulting full query string. Confirm against the SDK's actual `isEmbeddedRequest` check (shown above) that the resulting request will correctly evaluate as embedded so the loader's `shopifyRedirect(..., { target: "_top" })` call takes the `renderAppBridge` path instead of falling through to a plain redirect.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Reproduce and confirm the fix, and explain the literal "200"
New log evidence supports the Phase 1 diagnosis: `GET /app/usage?intent=choose_plan 200 - - 7.208 ms` (and a second occurrence at `4.373 ms`) both returned HTTP status **200**, not a 3xx redirect, and both were far faster than a normal Usage-page load (~400-600ms elsewhere in the same logs, since the normal loader path calls Shopify's Admin API for plan/overage data) — meaning the `intent === "choose_plan"` branch was reached and returned immediately, but did not produce a real redirect to `admin.shopify.com`. This is consistent with the missing `embedded=1` (and other context params) causing the SDK's `redirectFactory` to fall through to its last-resort branch (`return reactRouter.redirect(url, init)`), which is where you should look first once Phase 1's fix is in place — confirm this call actually now takes the `renderAppBridge`/data-request branch instead, and that the resulting response is a genuine 3xx (or the escape-iframe HTML) rather than a 200.

Reproduce the exact reported flow on a dev store (or as close to it as possible): load the Usage page embedded in Shopify admin, click a plan button, go through Shopify's hosted plan-selection page, choose a plan, and confirm the return trip lands back on a correctly rendered Usage page with the "You're now on the X plan" banner — not a bare "200" or any other broken response. While reproducing, check server logs for the exact request/response sequence to identify precisely what was serving the literal text "200" — whether it was the raw `Response` body from the fallback `reactRouter.redirect()` branch, a client-side rendering artifact, or something in `boundary.error`/`boundary.headers`'s handling of an unexpected response shape. Report what you find; don't just assume Phase 1 alone fully explains it if the logs show otherwise.
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Remove the app-handle diagnostic code (handle now captured)
The temporary diagnostic block added to `app/routes/app._index.tsx`'s loader has done its job — server logs now show `APP HANDLE: ai-name-app` captured on two separate requests, confirming the value. Remove the temporary `currentAppInstallation { app { handle } }` GraphQL query and the `console.log("APP HANDLE:", ...)` line from that loader, restoring it to what it was before that diagnostic change — same behavior, same return value, nothing else touched. Set `SHOPIFY_APP_HANDLE=ai-name-app` as an environment variable wherever this app's other env vars are configured (Render), if that variable is referenced anywhere in the codebase (check `plan-sync.server.ts`'s `planSelectionUrl` and any app-handle fallback logic) — flag it rather than guessing if you can't confirm where it's read from.
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/routes/app.usage.tsx`'s `goToPlanSelection` function, reading server/deployment logs, testing the flow on a dev store, editing `app/routes/app._index.tsx` in Phase 3 to remove the diagnostic query/log line.

## Forbidden actions
Do not change the loader's `shopifyRedirect`/`applyPlanHandle`/`syncPlanFromShopify` logic — the bug is in the client-side navigation dropping query params, not in the server-side redirect handling itself, unless Phase 2's investigation proves otherwise. Do not touch plan-gating, billing, or any other route. Do not remove any other console.log or query in `app._index.tsx` that predates the diagnostic change.

## Human review triggers
Stop and ask if Phase 2's investigation reveals the "200" text is coming from somewhere other than the missing embedded params (e.g. a genuine SDK issue, a Render/proxy-layer artifact, or something in the compliance-webhook or OAuth-redirect fixes from earlier prompts) — don't silently patch around a cause you haven't confirmed.

## Stop conditions
Report the diff after Phase 1, the reproduction result and root-cause explanation for the literal "200" after Phase 2, then the diff after Phase 3, then stop.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
