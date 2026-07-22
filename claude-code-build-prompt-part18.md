## Context (carry forward)
Stack: TypeScript, Prisma/Supabase. Confirmed via direct code reading plus real production evidence (Supabase `credit_ledger`/`usage_logs` tables and the Usage page): a serious gap in the self-enforced overage ceiling, which is this app's *only* protection against unbounded spend since Shopify App Pricing has no native spending cap (explicitly documented in `app/cofounder/overage.server.ts`'s own top comment).

`getOverageStatus()` (in `overage.server.ts`) computes `overageDollars` exclusively from `usage_logs.overage_dollars_billed`. That column is only ever incremented inside `reportOverage()`, and only *after* its `fetch(APP_EVENTS_URL, ...)` call succeeds (the increment happens inside the `try` block, after the response is confirmed `ok`; the `catch` block returns `{ sent: false, reason: "send_failed" }` without touching `usage_logs` at all). This project's own server logs already showed `App Events send failed (503): {"success":false,"error":"Service unavailable"}` occurring in production. When that happens, `overage_dollars_billed` silently stays wherever it was — meaning `getOverageStatus().blocked` (`inOverage && overageDollars >= ceiling`) can never become true no matter how much the shop actually uses past its included credits, as long as Shopify's App Events endpoint keeps failing. A live shop was observed with `credit_balance` fully depleted (0 remaining of 14,999,500) while "Extra usage this period" still read $0.00 of $600.00 — consistent with this exact failure mode.

`recordUsage()` (in `billing.server.ts`) already computes `overageCredits` correctly per turn (the portion of a turn's cost not covered by remaining balance) before calling `reportOverage` — that math is right; the only problem is where the ceiling-relevant number gets stored.

This prompt is 2 phases. Stop and report after each.

## Phase 1 — Track overage locally, independent of the Shopify App Events call succeeding
Add a way for the ceiling check to be self-contained rather than dependent on a third-party API call succeeding. Concretely: in `recordUsage()`, when `overageCredits > 0n`, increment `usage_logs.overage_dollars_billed` (or a new column if you decide the existing one should stay strictly "confirmed billed to Shopify" — your call, but the ceiling check in `getOverageStatus()` must read whichever column reflects *actual local usage*, not "successfully reported to Shopify") immediately, in the same request, regardless of whether `reportOverage`'s remote call later succeeds or fails. Then have `reportOverage` itself stop being responsible for the ceiling-relevant bookkeeping — its job becomes purely "best-effort tell Shopify's App Events API about this usage for their own billing," with its existing retry-free single-attempt behavior fine to keep, but its success/failure must no longer be the gate on whether the merchant's own spend gets counted toward the ceiling.

If you introduce a new column instead of repurposing `overage_dollars_billed`, add it via a proper Prisma migration, and update `getOverageStatus()` to read the new column. Preserve the meaning distinction clearly with a comment: one column tracks real accrued overage for the ceiling (always incremented), the other (if kept separate) tracks what Shopify has actually been billed for (only on confirmed App Events success) — these can legitimately drift apart when Shopify's endpoint has issues, and that's fine; the ceiling protecting this app's own cost exposure is the priority, not Shopify's billing ledger matching perfectly in real time.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Verify against the real data already in Supabase
Query the current `usage_logs` row for the shop shown in the screenshots (Founder plan, 0 of 14,999,500 credits remaining) and confirm what its `overage_dollars_billed` value actually is right now, and cross-check it against the sum of `credit_ledger.credits_deducted` for messages that landed after the balance hit zero. Report the actual numbers. Then, on a dev store, deliberately exhaust included credits (or adjust a test row directly if faster) and send further messages, confirming the Usage page's "Extra usage this period" now increments correctly and that `blocked` correctly becomes true once the ceiling is reached, independent of whether the App Events call to Shopify succeeds or fails.
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/cofounder/billing.server.ts` and `app/cofounder/overage.server.ts`, adding a Prisma migration if a new column is introduced, querying Supabase to verify current data, testing on a dev store.

## Forbidden actions
Do not remove or weaken the existing per-turn overage-credit math in `recordUsage` — it's correct. Do not make `reportOverage`'s Shopify-side reporting block or delay the chat response (that's Part 15's existing timeout fix, already separate scope — don't reintroduce blocking behavior here). Do not change plan-gating logic in `capabilities.server.ts`. Do not touch any Supabase table other than `usage_logs` (and a new column on it, if applicable).

## Stop conditions
Report the diff and reasoning after Phase 1, then the verification numbers and dev-store test result after Phase 2, then stop.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
