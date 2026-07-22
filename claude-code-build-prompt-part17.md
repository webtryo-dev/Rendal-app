## Context (carry forward)
Stack: TypeScript, Prisma/Supabase, Admin GraphQL 2026-07. Existing pattern to follow exactly, already established across every write tool in this codebase (`app/cofounder/*.tools.server.ts`): each write tool has a schema in its domain's `*_TOOL_DEFS` array, an entry in that domain's `*_WRITE_TOOL_NAMES` array, a case in `execute*WriteTool`, and a case in `summarize*Write` that builds the merchant-facing approval-card text — never execute a write without going through the existing approval-modal flow every other write already uses. All new GraphQL must be validated against the pinned 2026-07 Admin schema via shopify.dev before writing it, not assumed from memory (mutation shapes have shifted across API versions in this project before).

**Theme editing is explicitly out of scope for this prompt.** `theme.tools.server.ts` currently only has read tools (`list_themes`, `list_theme_files`, `read_theme_file`) — its write tools were deliberately removed earlier for Shopify App Store requirement 5.1.1 (apps can't modify merchant themes outside theme app extensions without an approved exemption), and that decision is still pending a separate exemption request. Do not touch `theme.tools.server.ts` or re-add `write_themes` to `shopify.app.toml` in this prompt.

Three real gaps to close, all confirmed by reading the actual tool files:

1. **No variant-level write tools exist beyond inventory quantity.** `app/cofounder/products.tools.server.ts`'s `update_product` only touches `title`/`descriptionHtml`/`status` — nothing variant-scoped (price, compareAtPrice, SKU, barcode, weight) and nothing for creating/deleting variants or defining product options (e.g. Size, Color). `get_product`'s existing query already returns each variant's `id`/`title`/`price`/`sku`/`inventoryQuantity`, so the model can already find a variant to target — it just has nothing to call to change one.
2. **Products can't have images added/removed, and options aren't manageable.** No image-attach/remove tool exists anywhere in `products.tools.server.ts`.
3. **Shipping zones/rates can be created and updated but never deleted.** `app/cofounder/shipping.tools.server.ts` has `create_shipping_zone`, `update_shipping_zone`, `set_shipping_rate` — no way to remove a zone or a rate.

This prompt is 3 phases. Stop and report after each.

## Phase 1 — Full variant management
In `app/cofounder/products.tools.server.ts`, add write tools for:
- Creating one or more variants on an existing product, including option values (e.g. Size: M, Color: Blue) and initial price/SKU.
- Updating a variant's price, compareAtPrice, SKU, barcode, and/or weight (whichever fields the current 2026-07 variant mutation actually supports — confirm exact field names against shopify.dev; likely `productVariantsBulkUpdate`, but verify rather than assume, per the note in the earlier price-editing prompt for this same codebase).
- Deleting a variant.
- Defining or updating a product's option set (e.g. adding a "Color" option with values) if the current API separates this from variant creation — check whether `productOptionsCreate`/`productOptionUpdate` (or the 2026-07 equivalent) is a separate mutation from variant creation, since Shopify's product/variant/option API has been restructured across versions.

Each new tool needs merchant approval before executing (add to `PRODUCTS_WRITE_TOOL_NAMES`, add a case to `executeProductsWriteTool`, add a case to `summarizeProductsWrite` showing exactly what will change — for price/compareAtPrice changes, show old value → new value the same way the earlier price-editing tool was asked to). Update tool descriptions so the model knows these now exist (in particular, `update_product`'s description currently doesn't mention variants — update it or the new tools' descriptions so the model routes variant-scoped requests to the right tool instead of `update_product`).
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Product images
Add a tool to attach one or more images to a product (accepting an image URL or the same base64-attachment pattern already used elsewhere in this app for images, e.g. in `image.tools.server.ts` — read that file first and reuse its attachment-handling approach rather than inventing a new one) and a tool to remove a product image. Both need merchant approval before executing, following the same pattern as Phase 1. Confirm the exact mutation names/shapes against 2026-07 (likely `productCreateMedia`/`productDeleteMedia` or the current equivalent — verify, don't assume).
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Delete shipping zones and rates
In `app/cofounder/shipping.tools.server.ts`, add a tool to delete a shipping zone and a tool to remove a shipping rate (method definition) from a zone, following the exact same `deliveryProfileUpdate` pattern the existing zone/rate tools already use (likely `zonesToDelete`/`methodDefinitionsToDelete` on the same `DeliveryProfileInput` — confirm the exact field names against 2026-07). Add both to `SHIPPING_WRITE_TOOL_NAMES`, `executeShippingWriteTool`, and `summarizeShippingWrite`, matching the existing style exactly (get ids from `get_shipping_setup` first, merchant approval before deleting, clear warning in the approval summary since removing a zone/rate is not easily undone and could leave a region unable to check out).
Stop here — end of scope for this prompt.

## Allowed actions
Editing `app/cofounder/products.tools.server.ts` (Phases 1-2) and `app/cofounder/shipping.tools.server.ts` (Phase 3), and whatever barrel/dispatch wiring in `app/cofounder/tools.server.ts` is needed to register new tool names — read that file first to confirm exactly what wiring is needed.

## Forbidden actions
Do not touch `theme.tools.server.ts`, do not re-add `write_themes` to `shopify.app.toml`, and do not build any theme file-editing or publish/unpublish capability in this prompt — that's explicitly pending a separate decision. Do not skip merchant approval for any new write. Do not guess at mutation names/input shapes — confirm each against current Admin API 2026-07 docs before writing it. Do not change any existing tool's behavior.

## Stop conditions
Report the diff and the exact mutations used (with confirmation they were checked against current docs) after each phase before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
