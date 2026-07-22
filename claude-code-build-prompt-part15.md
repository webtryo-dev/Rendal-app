## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. Two confirmed, code-verified causes of the app feeling slow between pages and on message send — not guesses, both traced through actual source.

**Cause 1 — unbounded App Events calls block the chat response.** `app/cofounder/overage.server.ts`'s `appEventsToken()` (line ~89, auth POST) and `reportOverage()` (line ~164, event POST) both call plain `fetch()` with no timeout or `AbortSignal` at all. `app/cofounder/billing.server.ts`'s `recordUsage()` awaits `reportOverage()` synchronously (line ~135), and that call happens before `app/routes/app.cofounder.tsx`'s `action` returns its response to the merchant. Real logs already captured in this project show the failure mode directly: `[overage] app event send failed for ...: Error: App Events send failed (503): {"success":false,"error":"Service unavailable"}` immediately followed by `POST /app/cofounder.data 200 - - 5896.560 ms` and, in a second occurrence, `5199.990 ms` — meaning when Shopify's own App Events endpoint is slow or erroring, the merchant's chat reply is delayed by the same multi-second amount.

**Cause 2 — every page load re-syncs plan state from Shopify's Admin API with no throttle.** `app/plan-sync.server.ts`'s `syncPlanFromShopify()` unconditionally calls `admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY)` every single time it runs — there is no caching or time-based skip. It's invoked via `ensureShop(session.shop, admin)` (without `skipPlanSync`) in `app/routes/app.cofounder.tsx` (both the loader and the action), `app/routes/app.skills.tsx`, `app/routes/app.exports.$id.tsx`, and `app/routes/app.images.$id.tsx` — meaning nearly every page navigation and every message send adds a full extra GraphQL round-trip to Shopify just to check plan status, even though the plan changes rarely. Only `app/routes/app.usage.tsx` and `app/shop.server.ts`'s `ensureShop()` itself already know about `{ skipPlanSync: true }`.

This prompt is 2 phases, independent of each other — order doesn't matter much, but do Phase 1 first since it's the more severe, spiky latency source. Stop and report after each.

## Phase 1 — Bound the App Events calls with a timeout, and stop blocking the chat reply on them
Add a reasonable timeout (e.g. `AbortSignal.timeout(4000)`, tune if needed) to both `fetch()` calls in `overage.server.ts` (`appEventsToken()` and the event POST inside `reportOverage()`), so a hanging or slow Shopify endpoint can never add more than a few seconds, not indefinitely. Existing error handling (the `catch` block logging `send_failed` and returning `{ sent: false, ... }`) already degrades gracefully — a timeout should just trigger that same path faster, not require new error-handling logic.

Separately, reconsider whether `recordUsage`'s call into `reportOverage` needs to block the merchant-visible chat response at all. The chat reply itself doesn't depend on whether the overage event reached Shopify — only the internal ceiling bookkeeping does. If it's safe given the existing `usage_logs` upsert and ceiling-check logic (re-read `getOverageStatus` and the ceiling-check-before-send logic in `reportOverage` to confirm), consider calling `recordUsage` without awaiting it in the action (fire-and-forget, with its own internal error handling already in place so nothing throws unhandled), so the chat response returns to the merchant immediately regardless of how long the App Events call takes. Only do this if you can confirm it doesn't create a real risk of undercounting overage before the next ceiling check — if there's genuine doubt, keep it awaited but bounded by the new timeout, and explain the tradeoff rather than guessing.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Throttle the plan-sync so it doesn't hit Shopify's Admin API on every request
Add a `plan_synced_at` (nullable `DateTime`) column to the `shops` model in `prisma/schema.prisma` via a proper migration. In `syncPlanFromShopify()`, skip the `admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY)` call entirely and return the shop's current plan state (`hasActiveSubscription` inferred from whatever was last known — store it or derive it reasonably) if `plan_synced_at` is within the last 5 minutes; otherwise perform the sync as today and update `plan_synced_at` to now. Confirm this doesn't weaken the immediate-update guarantee `applyPlanHandle()` already provides on the post-selection redirect (that function writes `shop.plan` directly and doesn't go through this throttle, so a merchant who just changed plans still sees it instantly) — this throttle only affects the passive, every-page-load re-check, not the active redirect-driven update.
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/cofounder/overage.server.ts` and `app/cofounder/billing.server.ts` (Phase 1), editing `app/plan-sync.server.ts` and adding a Prisma migration for `shops.plan_synced_at` (Phase 2).

## Forbidden actions
Do not change the ceiling-check math, `usage_logs` schema, or any plan-gating logic in `capabilities.server.ts`. Do not weaken `applyPlanHandle`'s immediate-update behavior on the post-plan-selection redirect. Do not remove the existing error handling in `reportOverage` — only bound its timing. Do not make `recordUsage` fire-and-forget in Phase 1 unless you've confirmed it's safe per the instructions above; if unsure, say so instead of guessing.

## Human review triggers
Stop and ask before running the Prisma migration in Phase 2 if it would require a destructive change to the `shops` table beyond adding one nullable column.

## Stop conditions
Report the diff and reasoning after each phase before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
