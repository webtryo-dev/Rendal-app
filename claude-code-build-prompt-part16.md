## Context (carry forward)
Stack: TypeScript, Prisma/Supabase, Admin GraphQL 2026-07. Confirmed via direct code reading — this is a real gap, not a scopes/permissions issue. `shopify.app.toml` already grants `write_products` (and every other scope the existing tools need); no scope change is required for what follows.

`app/cofounder/products.tools.server.ts`'s `update_product` tool only accepts `title`, `descriptionHtml`, and `status` in its input schema, and its mutation (`UPDATE_PRODUCT_MUTATION` → `productUpdate`) only sends those same three fields. There is no price field anywhere, and no separate variant-price tool exists in this file or anywhere else in `app/cofounder/*.tools.server.ts`. When a merchant asks to change a product's price, the model correctly (and honestly) reports it can't — the tool genuinely doesn't support it yet. This prompt adds that capability.

Reference for the existing pattern to follow: `set_inventory_quantity` in the same file already handles a variant-level write (via `inventoryItemId`/`locationId`), including its own approval-summary function in `summarizeProductsWrite`. `update_product` itself already has a merchant-approval flow (see how it's dispatched via `PRODUCTS_WRITE_TOOL_NAMES` and the generic approval-modal path in `cofounder.server.ts`/`app.cofounder.tsx` — read that dispatch path before writing new code so the new tool plugs into it the same way, rather than inventing a separate approval mechanism).

## Task
Add a way for the AI to change a variant's price, either by extending `update_product`'s schema or by adding a new tool (your call, based on which fits the existing dispatch/approval pattern more cleanly — a new `update_variant_price` tool is likely cleaner since `update_product`'s mutation operates on the product, not a specific variant, and price lives on `ProductVariant`).

Use the Admin GraphQL API's variant-price mutation for the pinned 2026-07 API version — validate the exact mutation name and input shape against shopify.dev before writing it (Shopify has had multiple product/variant mutation shapes across versions; do not assume `productVariantUpdate` still exists on this version without checking — `productVariantsBulkUpdate` is the more likely current one, but confirm).

The new tool must:
- Take a variant GID (reuse `get_product`'s existing variant listing, which already returns variant `id`/`title`/`price`/`sku`, so the model can find the right variant id — don't add a redundant lookup).
- Require merchant approval before executing, following the exact same pattern as `update_product`/`set_inventory_quantity` (add it to the write-tool-names list for this domain, add a case to `executeProductsWriteTool`, add a case to `summarizeProductsWrite` showing old price → new price in the approval card).
- Handle and surface `userErrors` from the mutation the same way every other write tool in this file does.
- Update the tool's description so the model knows this is now how to change a price (and, if you extend `update_product`'s own description instead of adding a separate tool, make sure that description no longer implies price isn't supported).

## Allowed actions
Editing only `app/cofounder/products.tools.server.ts`, and whatever barrel/dispatch wiring in `app/cofounder/tools.server.ts` is needed to register a new tool name (if you add one) — read that file first to confirm exactly what wiring is needed so nothing else breaks.

## Forbidden actions
Do not change `create_product`, `delete_product`, `set_inventory_quantity`, or any other existing tool's behavior. Do not skip the merchant-approval step — a price change must go through the same review-before-apply flow as every other write in this app. Do not guess at the mutation name/shape — confirm against current Admin API 2026-07 docs first.

## Stop conditions
Report the diff, the exact mutation used and why, and confirm on a dev store that asking to change a variant's price now produces an approval card (not the old "I can't do this" refusal) and correctly updates the price once approved.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
