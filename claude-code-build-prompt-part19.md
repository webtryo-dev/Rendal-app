## Context (carry forward)
Stack: TypeScript, Prisma/Supabase. Confirmed via an exhaustive grep of every `credit_balance` reference in the codebase (`app/cofounder/billing.server.ts`, `app/cofounder/overage.server.ts`, `app/routes/app.usage.tsx`, `prisma/schema.prisma`): the field is decremented on every message (`billing.server.ts` line ~102) and read for display/overage checks, but is **never incremented or topped up anywhere in the entire codebase.** `prisma/schema.prisma` only gives it `@default(0)`.

Real-world confirmation: a live shop on the Founder plan ($299.99/mo, 14,999,500 included credits per `pricing.server.ts`'s `PLANS` map) showed "0 of 14,999,500 credits remaining" on the Usage page — not because it used all 14,999,500, but because it was never granted any credits at all. Every shop, on every plan, starts at 0 and goes negative on its first message, meaning `getOverageStatus()`'s `inOverage = shop.credit_balance <= 0n` is true from message one for every merchant, on every plan tier, permanently — the included-credits allowance advertised on every pricing tier is never actually delivered. This also contradicts the website's own pricing-page copy (already shipped): "Included usage resets every month" — nothing currently resets it at all; `rolloverBillingPeriod()` (in `overage.server.ts`) only advances `billing_period_start`, it never touches `credit_balance`.

This is a foundational billing correctness bug, not a display issue, and it very likely also explains why the earlier-diagnosed overage-ceiling bug (Part 18: `overage_dollars_billed` never incrementing due to Shopify App Events 503s) hasn't been more visible — every shop has effectively been "in overage" from day one regardless, so the credits system as designed has never actually functioned as advertised for any real shop.

This prompt is 3 phases. Stop and report after each.

## Phase 1 — Grant included credits when a plan first becomes active
In `app/plan-sync.server.ts`'s `applyPlanHandle()` (fires when Shopify redirects the merchant back after choosing/changing a plan) and in `syncPlanFromShopify()` (fires on passive re-sync — specifically the branch where `mapped !== shop.plan`, meaning the plan actually changed), set `credit_balance` to the newly-selected plan's `includedCredits` (from `pricing.server.ts`'s `PLANS[key].includedCredits`) in the same `prisma.shops.update`/`upsert` call that sets the new `plan` value. This must happen for both the initial plan selection (a shop that previously had no plan) and any subsequent plan change (upgrade/downgrade) — in both cases the merchant should start their new plan with its full included-credit balance, not carry over whatever was left (or wasn't) from before.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Reset credit_balance on each billing-period rollover
In `overage.server.ts`'s `rolloverBillingPeriod()`, when it detects an elapsed period and advances `billing_period_start`, also reset `credit_balance` to the shop's *current* plan's `includedCredits` (re-read `planConfig(shop.plan)` at rollover time, since the merchant may have changed plans since the last rollover) — matching the "included usage resets every month" behavior already promised on the pricing page. This is a reset, not an accumulation: unused credits from the prior period do not carry over, and this rollover must happen regardless of whether the shop's balance was positive or negative going into it.
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Backfill existing shops and verify
Every shop already in production has an incorrect `credit_balance` right now (started at 0, likely negative from real usage) even though this isn't really their fault — they were never granted what their plan promised. Write a one-time backfill (a script or a guarded migration step — your call on which fits this codebase's conventions better) that sets every existing shop's `credit_balance` to its current plan's `includedCredits`, run once, not left as permanent app logic. Confirm this only runs once and doesn't accidentally re-run on every deploy. After backfilling, verify against the actual shop referenced in the screenshots (Founder plan, shop domain visible in the Supabase `shops` table) that its `credit_balance` and the Usage page's "remaining" figure now correctly show close to 14,999,500 (minus whatever it has genuinely used since the backfill).
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/plan-sync.server.ts` and `app/cofounder/overage.server.ts`, writing and running a one-time backfill script/migration for existing `shops` rows, querying Supabase to verify.

## Forbidden actions
Do not change the per-message deduction math in `recordUsage` — it's correct once the starting balance is right. Do not make the backfill script part of the app's normal runtime path (e.g., don't run it on every `ensureShop` call) — it must be a one-time, explicitly-run operation. Do not touch plan-gating logic in `capabilities.server.ts` or the overage-ceiling tracking from Part 18 — this is a separate, upstream bug (the starting balance), not the ceiling-tracking mechanism itself.

## Human review triggers
Stop and ask before running the Phase 3 backfill against production data — confirm the exact set of shops and the exact `includedCredits` value each will be set to before executing.

## Stop conditions
Report the diff and reasoning after each phase before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
