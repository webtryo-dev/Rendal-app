## Context (carry forward)
A prior change added a temporary diagnostic block to `app/routes/app._index.tsx`'s loader: a GraphQL query to `currentAppInstallation { app { handle } }` plus a `console.log("APP HANDLE:", ...)` line, added solely to read this app's Shopify handle from the server logs. The handle value has now been captured from the dev-store run and is no longer needed in code.

This prompt has 2 phases. Stop and report after each.

## Phase 1 — Remove the temporary diagnostic code
In `app/routes/app._index.tsx`, remove the temporary `currentAppInstallation { app { handle } }` GraphQL query and the `console.log("APP HANDLE:", ...)` line added for that purpose, restoring the loader to exactly what it was before that diagnostic change — same behavior, same return value, nothing else touched.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Run the official Shopify AI self-review
Shopify provides an AI Toolkit with a self-review skill that checks this codebase against every App Store requirement that can be evaluated from local code. If the Shopify AI Toolkit plugin isn't already installed for this environment, install it first (`claude plugin install shopify-ai-toolkit@claude-plugins-official`). Then invoke the self-review skill by running the `/shopify-app-store-review` command. Report its full output — likely-passing, likely-failing, and needs-review items — without making any code changes yet. Note explicitly that this self-review only covers what's checkable from code; it does not verify app listing content, live behavior, or merchant-facing UX, and Shopify's own review team still checks everything after submission regardless of this result.
Stop here — do not act on any findings yet. Wait for explicit direction on which findings (if any) to fix before making further changes.

## Phase 3 — Rename and delete chats from history
The chat sidebar in `app/routes/app.cofounder.tsx` (around where `chats.map((chat) => ...)` renders each row with `chat.title ?? "Untitled chat"`) currently has no way to rename or delete a chat. Add both, backed by `app/cofounder/chats.server.ts`, which already has `createChat`, `getShopChat`, `listChats`, `loadChatMessages`, `persistMessages` — follow the same ownership-check pattern `getShopChat` uses (verify `chat.shop_id === shopId` before acting) so a shop can never rename or delete another shop's chat.

Add two functions to `chats.server.ts`:
- `renameChat(shopId, chatId, title)` — verify ownership, then `prisma.chats.update` the `title` field. Trim/cap the new title similarly to how `createChat` derives one from the first message (reasonable max length, no empty string allowed — fall back to keeping the existing title if the new one is blank).
- `deleteChat(shopId, chatId)` — verify ownership first. Before deleting, check the actual Prisma-generated migration/DB constraint on `credit_ledger.chat_message_id` (it references `chat_messages.id`, which cascade-deletes when a chat is deleted, but `credit_ledger`'s own `onDelete` behavior isn't explicitly set in the schema) — confirm whether deleting a chat's messages would violate that foreign key before writing the delete. If needed, null out `credit_ledger.chat_message_id` for the affected rows first so billing history is preserved but no longer points at a deleted message, then delete the chat (which cascades to `chat_messages`).

In `app.cofounder.tsx`, add two new action intents following the existing `chat` / `resolve_write` / `load_chat` pattern: `rename_chat` (chatId, title) and `delete_chat` (chatId), each re-verifying the chat belongs to the current shop via `getShopChat` before calling the new server functions.

In the sidebar UI, add a rename control (inline edit, e.g. click the title to turn it into a text input, save on blur/enter) and a delete control per chat row. Deleting is destructive and must require an explicit confirm step before it executes — do not delete on a single click, matching the approval-first pattern already used elsewhere in this app for destructive actions. If the deleted chat is the currently active one, clear `activeChatId` and fall back to the empty/no-chat-selected state exactly as it behaves today when no chat has been opened yet.
Stop here — end of scope for this prompt.

## Allowed actions
Editing only `app/routes/app._index.tsx` in Phase 1 to remove the diagnostic query/log line; installing the Shopify AI Toolkit plugin and running its self-review command in Phase 2; editing `app/cofounder/chats.server.ts` and `app/routes/app.cofounder.tsx` in Phase 3 to add rename/delete.

## Forbidden actions
Do not modify any other file or any other part of the loader in Phase 1. Do not remove any other console.log or query that predates the diagnostic change. Do not make any code changes in response to the Phase 2 self-review's findings without explicit confirmation on which ones to address — just report them. Do not delete a chat without an explicit confirm step in the UI. Do not guess at the `credit_ledger` foreign-key delete behavior in Phase 3 — verify it against the actual migration/schema before writing the delete logic. Do not touch plan-gating, billing math, or any other route.

## Stop conditions
Report the exact diff after Phase 1, the full self-review output after Phase 2, and the diff plus what was found about the `credit_ledger` FK behavior after Phase 3, then stop.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
