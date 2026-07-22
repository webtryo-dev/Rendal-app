# DESIGN.md — Rendal for Shopify

> App brand name: **Rendal**. The chat screen's nav entry is labelled **Chat**.
> ("AI Co-Founder" below is the original working name; the app is now Rendal.)

Recreated 2026-07-13 (original design doc was lost). Approved layout decisions below
were made by the product owner; build to match this document exactly.

## What this app is

An embedded Shopify admin app: an AI co-founder chat that lives inside the Shopify
admin (never a separate tab). Merchants chat with an AI that can read and — with
explicit approval — write to their store via the Admin GraphQL API. Merchants can
switch between Claude, GPT, and Gemini mid-conversation, attach images, and trigger
custom "skills" (uploaded .md instruction files) by typing `/`.

## Design system decision

**Polaris web components** (`<s-page>`, `<s-section>`, `<s-box>`, …) as shipped with
the shopify-app-template-react-router scaffold, typed via `@shopify/polaris-types`.
This is Shopify's current Polaris surface for embedded "App Home" apps. The
`@shopify/polaris` React package is **not** used and must not be added. No other UI
library, no hand-written CSS beyond what Polaris tokens/attributes provide.
Component names below are indicative; verify exact attribute names against
shopify.dev docs at implementation time — never from memory.

## Main chat screen (`/app/cofounder`)

Two-pane layout inside one `<s-page heading="AI Co-Founder">`:

```
┌─ AI Co-Founder ──────────────────────────────────────────────┐
│ ┌─ Sidebar ────────┐  ┌─ Chat ─────────────────────────────┐ │
│ │ [+ New chat]     │  │                 ┌────────────────┐ │ │
│ │ ──────────────── │  │                 │ merchant msg   │ │ │
│ │ Chat history     │  │                 └────────────────┘ │ │
│ │  • Pricing help  │  │ ┌ [Sonnet 5] ──────────┐           │ │
│ │  • SEO audit     │  │ │ AI reply             │           │ │
│ │  • …             │  │ └──────────────────────┘           │ │
│ │ ──────────────── │  │            (scrollable)            │ │
│ │ Customize        │  ├────────────────────────────────────┤ │
│ │  ⚙ Connect MCP   │  │ [ Type a message…                ] │ │
│ │  ⬆ Upload skill  │  │ [Model ▾] [📎 Attach]       [Send] │ │
│ └──────────────────┘  └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Sidebar (left column)
- **New chat** button (full-width, at top) — starts a fresh conversation.
- **Chat history** — list of the shop's past conversations, most recent first;
  clicking one loads it into the chat pane.
- **Customize** section at the bottom:
  - **Connect MCP server** — *design placeholder only; not in current build scope.
    Render the entry disabled or behind a "coming soon" tooltip until it is
    scheduled into a phase.*
  - **Upload skill (.md)** — links to the skills manager screen (Phase 4).

### Chat pane (right column, dominant width ~70/30)
- **Message history**: scrollable region, aligned bubbles:
  - Merchant messages right-aligned, subdued-background `s-box` bubble.
  - AI messages left-aligned, bordered bubble with a **model badge**
    (e.g. `Claude Sonnet 5`) above/inside the bubble so it's always clear which
    model produced each message in a mixed-model conversation.
  - Tool-call activity (e.g. "Reading products…") renders as a compact inline
    status row between bubbles, not as a bubble.
- **Composer** (pinned below history):
  - Multiline text field, placeholder "Type a message…". `/` at the start of a
    word opens the skills autocomplete (Phase 4).
  - Row under the field: **model switcher** (compact select, grouped by provider),
    **attach** (image upload), **Send** (primary).

## Write-approval modal (global invariant)

Every store write the AI proposes (product update, inventory, discount, …) renders
a confirmation modal before execution — "Approve this change?" with a human-readable
summary of exactly what will change, Approve / Cancel. **No silent writes, ever.**
Reads never prompt.

## Model catalog & tiers

| Tier     | Claude          | GPT       | Gemini            | Available on plan |
|----------|-----------------|-----------|-------------------|-------------------|
| Standard | Claude Sonnet 5 | GPT-5.4   | Gemini 3.5 Flash  | all plans         |
| Premium  | Claude Opus 4.8 | —         | Gemini 3.1 Pro    | Scale, Founder    |
| Flagship | Claude Fable 5  | GPT-5.6 Sol | —               | Founder only      |

Models above the shop's plan appear in the switcher disabled with an upgrade hint.

## Skills manager screen (`/app/skills`, Phase 4)

Standard Polaris resource screen: upload a `.md` file (name + trigger derived from
frontmatter or filename), list existing skills with edit/delete, timestamps shown.
Delete confirms via modal.

## Billing screen (`/app/billing`, Phase 5)

Plan cards with feature lists (model tiers unlocked), current-plan badge, and
subscribe/upgrade actions. Prices and included credits (retail rate 50,000
credits/$1):

| Plan    | Price    | Included credits |
|---------|----------|------------------|
| Starter | $19.99   | 999,500          |
| Growth  | $49.99   | 2,499,500        |
| Scale   | $149.99  | 7,499,500        |
| Founder | $299.99  | 14,999,500       |

Billing runs on **Shopify App Pricing** (App Events API + a Partner Dashboard
meter `extra_credit_usage`), not the older AppSubscription/Managed Pricing flow.
There is no native spending cap, so the overage ceiling is enforced in-app.
Usage counter (messages this billing period) shown on this page.

## Navigation

Admin sidebar (`<s-app-nav>` in `app/routes/app.tsx`): Home, **AI Co-Founder**,
then (as built) Skills, Billing. Labels are short nouns per Shopify nav guidelines.

## Build phases & guardrails (unchanged)

1. Foundation: nav entry + empty page. 2. Single-model chat (Claude) + 2–3 admin
tools with approval modals. 3. Multi-model adapter (GPT, Gemini) + more tools.
4. Skills system. 5. Billing + usage counter. Each phase stops for review. No new
dependencies, schema changes, or file deletions without explicit approval. All
secrets via env vars, documented in `.env.example`.
