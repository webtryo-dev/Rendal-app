To test this app:

No separate login or test account exists — it's an embedded Shopify admin app authenticated via Shopify's own OAuth using the store's admin credentials.

1. Install the app on a development store using the provided install link.
2. You're redirected to Shopify's own hosted plan-selection page — choose any plan to continue. This is required once; after choosing, you land on the Chat tab.
3. In the model switcher at the top of chat, pick a model (Claude, GPT, or Gemini) and ask a read-only question, e.g. "List my products" — it answers directly, no approval needed.
4. Ask for a change, e.g. "Raise the price of [any product] by 10%" or "Create a 10% discount code." The app proposes the change as a field-level review card — nothing saves yet.
5. Click Approve to confirm it writes to the store, or Discard to confirm nothing changes.
6. Click the attach icon, upload an image or PDF, and ask about it to test file input.
7. Open the Skills tab, upload any .md file (name/trigger inferred from the filename, or set via frontmatter). Back in Chat, type "/" plus that trigger to run it.
8. Switch models mid-conversation to confirm context carries over.
9. Open the Usage tab to see the current plan and credits, and use "Switch plan" to confirm changing plans works without contacting support or reinstalling.

Notes: some scopes (e.g. customer PII) are gated behind Shopify's separate Protected Customer Data approval and won't return data until granted — expected, not a bug.
