## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, Prisma/Supabase. This consolidates five pieces of outstanding work into one prompt, in the order they should happen. Everything below is grounded in real code already read and real server logs already seen — no guessing.

- **App handle already captured.** A temporary diagnostic block in `app/routes/app._index.tsx`'s loader (a `currentAppInstallation { app { handle } }` query plus `console.log("APP HANDLE:", ...)`) has done its job — Render logs show `APP HANDLE: ai-name-app` on two separate requests. It's confirmed and no longer needed in code.
- **Plan-selection redirect is broken.** `app/routes/app.usage.tsx`'s `goToPlanSelection` does `window.location.assign("/app/usage?intent=choose_plan")` — a bare URL missing `embedded=1`, `host`, `shop`, and the session context the original page load had. The Shopify SDK's redirect helper (`node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/admin/helpers/redirect.js`) decides how to escape the iframe based on whether the *current* request looks embedded (`isEmbeddedRequest` checks for `embedded=1`); without it, the loader's `shopifyRedirect(planSelectionUrl(session.shop), { target: "_top" })` call falls through to a plain `reactRouter.redirect(url, init)` instead of the correct iframe-escape path. Server logs confirm the symptom: `GET /app/usage?intent=choose_plan 200` twice, both in 4-7ms — a plain 200, not a redirect, and far faster than a normal Usage load (~400-600ms, since that path calls Shopify's Admin API). This matches a merchant reporting the page shows a bare "200" instead of Shopify's hosted plan page after clicking any plan (Founder or otherwise).
- **No chat rename/delete.** The chat sidebar in `app/routes/app.cofounder.tsx` (`chats.map((chat) => ...)`, rendering `chat.title ?? "Untitled chat"`) has no way to rename or delete a chat. Backing functions belong in `app/cofounder/chats.server.ts`, which already has `createChat`, `getShopChat` (ownership-check pattern: `chat.shop_id === shopId`), `listChats`, `loadChatMessages`, `persistMessages`.
- **App Store self-review hasn't been run.** Shopify's AI Toolkit includes a self-review skill (`/shopify-app-store-review`) that checks this codebase against every App Store requirement checkable from local code. Install via `claude plugin install shopify-ai-toolkit@claude-plugins-official` if not already present.

This prompt is 5 phases, in the order listed. Stop and report after each.

## Phase 1 — Remove the app-handle diagnostic code
In `app/routes/app._index.tsx`, remove the temporary `currentAppInstallation { app { handle } }` GraphQL query and the `console.log("APP HANDLE:", ...)` line, restoring the loader to what it was before that diagnostic change — same behavior, same return value, nothing else touched. Set `SHOPIFY_APP_HANDLE=ai-name-app` as an environment variable wherever this app's other env vars live (Render), if that variable is referenced anywhere in the codebase (check `plan-sync.server.ts`'s `planSelectionUrl` and any app-handle fallback logic) — flag it rather than guessing if you can't confirm where it's read from.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Fix `goToPlanSelection` to preserve embedded context
Change `goToPlanSelection` in `app/routes/app.usage.tsx` so the navigation URL keeps the current page's existing query parameters (at minimum `embedded`, `host`, `shop` — whatever `window.location.search` already contains) and adds `intent=choose_plan` on top, rather than discarding everything. Read the current `window.location.search`, parse it, set `intent=choose_plan`, and navigate to the resulting full query string. Confirm against the SDK's actual `isEmbeddedRequest` check (in `redirect.js`, checks for `embedded=1`) that the resulting request will correctly evaluate as embedded so the loader's `shopifyRedirect(..., { target: "_top" })` call takes the proper iframe-escape path instead of falling through to a plain redirect.
Stop here and wait for confirmation before continuing to Phase 3.

## Phase 3 — Reproduce and confirm the fix, and explain the literal "200"
Reproduce the exact flow on a dev store: load the Usage page embedded in Shopify admin, click a plan button, go through Shopify's hosted plan-selection page, choose a plan, and confirm the return trip lands back on a correctly rendered Usage page with the "You're now on the X plan" banner — not a bare "200" or any other broken response. Check server logs for the exact request/response sequence to identify precisely what was serving the literal text "200" — whether it was the raw `Response` body from the fallback `reactRouter.redirect()` branch, a client-side rendering artifact, or something in `boundary.error`/`boundary.headers`'s handling of an unexpected response shape. Report what you find; don't assume Phase 2 alone fully explains it if the logs show otherwise.
Stop here and wait for confirmation before continuing to Phase 4.

## Phase 4 — Rename and delete chats from history
Add two functions to `app/cofounder/chats.server.ts`, following `getShopChat`'s ownership-check pattern (`chat.shop_id === shopId`) so a shop can never touch another shop's chat:
- `renameChat(shopId, chatId, title)` — verify ownership, then `prisma.chats.update` the `title` field. Trim/cap the new title similarly to how `createChat` derives one from the first message; fall back to keeping the existing title if the new one is blank.
- `deleteChat(shopId, chatId)` — verify ownership first. Before deleting, check the actual Prisma-generated migration/DB constraint on `credit_ledger.chat_message_id` (it references `chat_messages.id`, which cascade-deletes when a chat is deleted, but `credit_ledger`'s own `onDelete` behavior isn't explicitly set in the schema) — confirm whether deleting a chat's messages would violate that foreign key before writing the delete. If needed, null out `credit_ledger.chat_message_id` for the affected rows first so billing history is preserved but no longer points at a deleted message, then delete the chat (cascades to `chat_messages`).

In `app/routes/app.cofounder.tsx`, add two new action intents following the existing `chat` / `resolve_write` / `load_chat` pattern: `rename_chat` (chatId, title) and `delete_chat` (chatId), each re-verifying the chat belongs to the current shop via `getShopChat` before calling the new server functions.

In the sidebar UI, add a rename control (inline edit — click the title to turn it into a text input, save on blur/enter) and a delete control per chat row. Deleting is destructive and must require an explicit confirm step before it executes — do not delete on a single click. If the deleted chat is the currently active one, clear `activeChatId` and fall back to the empty/no-chat-selected state exactly as it behaves today when no chat has been opened yet.
Stop here and wait for confirmation before continuing to Phase 5.

## Phase 5 — Run the official Shopify AI self-review
If the Shopify AI Toolkit plugin isn't already installed for this environment, install it (`claude plugin install shopify-ai-toolkit@claude-plugins-official`). Then invoke the self-review skill by running `/shopify-app-store-review`. Report its full output — likely-passing, likely-failing, and needs-review items — without making any code changes yet. Note explicitly that this self-review only covers what's checkable from code; it doesn't verify app listing content, live behavior, or merchant-facing UX, and Shopify's own review team still checks everything after submission regardless of this result.
Stop here — do not act on any findings yet. Wait for explicit direction on which findings (if any) to fix.

## Allowed actions
Editing `app/routes/app._index.tsx` (Phase 1), `app/routes/app.usage.tsx` (Phase 2), reading server/deployment logs and testing on a dev store (Phase 3), editing `app/cofounder/chats.server.ts` and `app/routes/app.cofounder.tsx` (Phase 4), installing the Shopify AI Toolkit plugin and running its self-review command (Phase 5).

## Forbidden actions
Do not remove any other console.log or query in `app._index.tsx` that predates the diagnostic change. Do not change the loader's `shopifyRedirect`/`applyPlanHandle`/`syncPlanFromShopify` logic in Phase 2 — the bug is in the client-side navigation dropping query params, not the server-side redirect handling, unless Phase 3's investigation proves otherwise. Do not delete a chat without an explicit confirm step in the UI. Do not guess at the `credit_ledger` foreign-key delete behavior in Phase 4 — verify it against the actual migration/schema before writing the delete logic. Do not make any code changes in response to Phase 5's self-review findings without explicit confirmation on which ones to address — just report them. Do not touch plan-gating logic, billing math, or any route not named above.

## Human review triggers
Stop and ask if Phase 3's investigation reveals the "200" text is coming from somewhere other than the missing embedded params (a genuine SDK issue, a Render/proxy-layer artifact, or something in the compliance-webhook or OAuth-redirect fixes from earlier work) — don't silently patch around a cause you haven't confirmed.

## Stop conditions
Treat each of the 5 phases as its own checkpoint. Report what changed or was found after each one before moving to the next.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
