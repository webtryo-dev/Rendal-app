## Context (carry forward)
Stack: TypeScript, React Router. Root cause confirmed by direct code reading in `app/routes/app.cofounder.tsx` — this is a client-side UI bug only; the server never calls the AI for rename/delete.

Server-side, `rename_chat` and `delete_chat` are already handled correctly and return before any AI code runs (lines ~120-132 of the `action` function, well before the `runChatTurn`/`resolveWrite` calls used only by the `chat`/`resolve_write` intents).

The bug is client-side: `const isBusy = fetcher.state !== "idle";` (line 463) is a single flag shared by every fetcher submission — `chat`, `resolve_write`, `load_chat`, `rename_chat`, and `delete_chat` all set it. Two places key off this same generic `isBusy` in ways that only make sense for an actual AI turn:
- The live-status polling `useEffect` (lines ~517-539) starts polling `/app/cofounder-step` for the current AI step the instant `isBusy` becomes true, for any submission.
- The render block at line ~861 shows `{isBusy && (... <s-text>{liveStep ?? "Thinking…"}</s-text> ...)}` — meaning renaming or deleting a chat now visibly shows "Thinking…" and the AI step indicator, even though nothing AI-related is happening.

## Task
Add a way to know which intent is actually in flight, and scope the "Thinking…" UI and the live-step polling to only the two intents that are real AI turns (`chat` and `resolve_write`) — not `load_chat`, `rename_chat`, or `delete_chat`.

Concretely: track the in-flight intent (e.g. a `pendingIntent` state set immediately before each `submitJson` call in `sendMessage`, `resolvePendingWrite`, `openChat`, `commitRename`, and `confirmDelete`, cleared once the fetcher returns to idle). Derive a new value, e.g. `isAiBusy = isBusy && (pendingIntent === "chat" || pendingIntent === "resolve_write")`, and use `isAiBusy` in place of `isBusy` specifically for: the live-step polling `useEffect`'s condition, and the "Thinking…"/`liveStep` render block. Leave every other use of `isBusy` (the disable-guards on `sendMessage`, `resolvePendingWrite`, `openChat`, `startNewChat`, `startRename`, `requestDelete`, `confirmDelete`, and the send-button's `loading` prop at line ~994) exactly as they are — those correctly need to block on any in-flight fetcher call, not just AI ones.

## Allowed actions
Editing only `app/routes/app.cofounder.tsx`.

## Forbidden actions
Do not change the server-side `action` function's intent handling — it's already correct. Do not change what `isBusy` itself means or remove it; add `pendingIntent`/`isAiBusy` alongside it. Do not touch `app/routes/app.cofounder-step.tsx` or any other route.

## Stop conditions
Report the diff, then confirm on a dev store that renaming or deleting a chat no longer shows "Thinking…" or triggers the step-polling network calls, while sending an actual message still does.

---
This prompt is for an agentic tool with real system access. Review the scope locks, forbidden actions, and stop conditions before pasting. Confirm file paths, directories, and permissions match the actual project.
