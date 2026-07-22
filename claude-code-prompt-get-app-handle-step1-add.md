## Context (carry forward)
Stack: TypeScript, `@shopify/shopify-app-react-router`, `authenticate.admin(request)` already runs in `app/routes/app._index.tsx`'s loader. Goal: get this app's exact Shopify `handle` value (needed for a `SHOPIFY_APP_HANDLE` env var used elsewhere) by reading it straight from the Admin GraphQL API rather than guessing it from a dashboard URL.

This is a temporary, one-time diagnostic change — it will be removed in a follow-up prompt right after the handle is captured.

## Task
In `app/routes/app._index.tsx`, inside the existing loader, after `const { admin } = await authenticate.admin(request);`, add a GraphQL query to `currentAppInstallation { app { handle } }` and `console.log("APP HANDLE:", ...)` the returned handle value. Do not change anything else in the loader — the rest of its logic, return value, and behavior must stay exactly as it is today.

## Allowed actions
Editing only `app/routes/app._index.tsx`, adding the query and the one console.log line.

## Forbidden actions
Do not modify any other file. Do not change the loader's existing return value or behavior. Do not remove this code yourself — a separate prompt will do that after the handle value has been captured from the logs.

## Stop conditions
Report the exact diff after making the change, then stop.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
