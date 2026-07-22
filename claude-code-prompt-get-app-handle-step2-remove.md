## Context (carry forward)
A prior change added a temporary diagnostic block to `app/routes/app._index.tsx`'s loader: a GraphQL query to `currentAppInstallation { app { handle } }` plus a `console.log("APP HANDLE:", ...)` line, added solely to read this app's Shopify handle from the server logs. The handle value has now been captured from the dev-store run and is no longer needed in code.

This prompt has 2 phases. Stop and report after each.

## Phase 1 — Remove the temporary diagnostic code
In `app/routes/app._index.tsx`, remove the temporary `currentAppInstallation { app { handle } }` GraphQL query and the `console.log("APP HANDLE:", ...)` line added for that purpose, restoring the loader to exactly what it was before that diagnostic change — same behavior, same return value, nothing else touched.
Stop here and wait for confirmation before continuing to Phase 2.

## Phase 2 — Run the official Shopify AI self-review
Shopify provides an AI Toolkit with a self-review skill that checks this codebase against every App Store requirement that can be evaluated from local code. If the Shopify AI Toolkit plugin isn't already installed for this environment, install it first (`claude plugin install shopify-ai-toolkit@claude-plugins-official`). Then invoke the self-review skill by running the `/shopify-app-store-review` command. Report its full output — likely-passing, likely-failing, and needs-review items — without making any code changes yet. Note explicitly that this self-review only covers what's checkable from code; it does not verify app listing content, live behavior, or merchant-facing UX, and Shopify's own review team still checks everything after submission regardless of this result.
Stop here — do not act on any findings yet. Wait for explicit direction on which findings (if any) to fix before making further changes.

## Allowed actions
Editing only `app/routes/app._index.tsx` in Phase 1 to remove the diagnostic query/log line; installing the Shopify AI Toolkit plugin and running its self-review command in Phase 2.

## Forbidden actions
Do not modify any other file or any other part of the loader in Phase 1. Do not remove any other console.log or query that predates the diagnostic change. Do not make any code changes in response to the Phase 2 self-review's findings without explicit confirmation on which ones to address — just report them.

## Stop conditions
Report the exact diff after Phase 1, then the full self-review output after Phase 2, then stop.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
