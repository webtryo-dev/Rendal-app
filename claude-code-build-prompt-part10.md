## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. Part 8 already built plan-sync: `app/plan-sync.server.ts`'s `syncPlanFromShopify(shop, admin)` queries `currentAppInstallation.activeSubscriptions` and returns `{ shop, hasActiveSubscription: boolean | null }` — `true` when an active Shopify App Pricing subscription exists, `false` when Shopify positively confirms there is none, `null` when the lookup itself failed (network/API error — must never be treated as "no plan," since that would lock merchants out over a transient error). `app/shop.server.ts`'s `ensureShop(shopDomain, admin, options?)` upserts the shop row and, unless `{ skipPlanSync: true }` is passed, calls `syncPlanFromShopify` internally but currently discards the `hasActiveSubscription` flag — it only returns the shop row. `app/routes/app.usage.tsx` already works around this by calling `ensureShop(session.shop, admin, { skipPlanSync: true })` then its own explicit `syncPlanFromShopify(shop, admin)` call to get `noPlanSelected = sync.hasActiveSubscription === false`, which drives its "No plan selected yet" messaging and plan-chooser section from Part 8 Phase 2.

Right now, a shop with no active subscription still gets full app access — `shops.plan` just sits at Prisma's `@default("starter")` and every feature gated to Starter-tier works normally. The request: block real app usage entirely until a merchant has actually chosen a plan through Shopify's hosted pricing flow. Don't silently treat "no plan chosen" as "on Starter."

Files that call `ensureShop` today, each with their own loader: `app/routes/app.cofounder.tsx` (loader + action, 2 call sites), `app/routes/app.exports.$id.tsx`, `app/routes/app.images.$id.tsx`, `app/routes/app.skills.tsx` (2 call sites), and `app/routes/app.usage.tsx` (already handles its own sync). The shared parent layout is `app/routes/app.tsx`, whose loader currently only does `authenticate.admin(request)` and returns the API key — it runs on every request to any `/app/*` route since it's the parent route for the embedded app shell (`s-app-nav` with Chat/Skills/Usage links, `<Outlet />`).

This prompt is 2 phases. Stop and report after each.

## Phase 1 — Gate all `/app/*` routes except Usage behind plan selection
In `app/routes/app.tsx`'s loader, after `authenticate.admin(request)`, call `ensureShop(session.shop, admin, { skipPlanSync: true })` then `syncPlanFromShopify(shop, admin)` directly — the exact same two-call pattern `app.usage.tsx` already uses, so this doesn't duplicate `ensureShop`'s own internal sync. If the result's `hasActiveSubscription === false` (explicitly false, not null) and the current request's path is not `/app/usage` (check `new URL(request.url).pathname`), redirect to `/app/usage` instead of returning the normal loader data. If `hasActiveSubscription` is `true` or `null`, proceed normally — `null` means the lookup failed and must never block access.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Make the Usage page's no-plan state unmistakable
On `app/routes/app.usage.tsx`, when `noPlanSelected` is true, the plan-chooser section from Part 8 Phase 2 should be the clear, primary focus of the page — normal usage stats (credits remaining, billing period, etc.) don't apply yet and should be hidden or replaced with a short explanation, not shown alongside a plan-chooser as if both were equally relevant. Headline language should make it unambiguous that the merchant must pick a plan to use the rest of the app (e.g. "Choose a plan to start using Rendal" rather than a softer "no plan selected yet" aside). Don't touch the plan-chooser's actual mechanics (the deep link to Shopify's hosted pricing page) — only the page's visual hierarchy and copy when this state is active.
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/routes/app.tsx`'s loader to add the plan-selection gate, editing `app/routes/app.usage.tsx`'s no-plan-selected UI state.

## Forbidden actions
Do not change `shops.plan`'s Prisma default or any plan-gating logic in `capabilities.server.ts` — those are unaffected by this change, since this is an access gate that runs before any of that logic matters. Do not treat `hasActiveSubscription === null` as equivalent to `false` — a failed lookup must never lock a merchant out. Do not add this gate to `app/routes/app.usage.tsx` itself (it must always remain reachable) or to any auth/webhook routes outside `/app/*`. Do not duplicate the sync call inside every individual child route — the parent `app.tsx` loader gate is sufficient; leave `app.cofounder.tsx`, `app.skills.tsx`, etc.'s own `ensureShop` calls exactly as they are.

## Human review triggers
Stop and ask if React Router's data-loading behavior in this app's version runs child loaders in a way where a parent-route redirect doesn't reliably prevent the child route's own loader/action logic from executing — confirm the redirect actually blocks reaching Chat/Skills before relying on it as the sole enforcement mechanism.

## Stop conditions
Treat each phase as its own checkpoint. Report what changed after each one before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
