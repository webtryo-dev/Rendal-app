# Rendal — App Store Screenshot Prompts (Higgsfield), v2

Updated for the current app: the Usage page now has a real plan-chooser (Starter/Growth/Scale/Founder cards), so that replaces the old credits-only shot — it's the strongest install-decision screenshot you have. All 5 are built around a real screenshot, never a generated fake UI — Shopify's guidelines require screenshots to show the actual app; Higgsfield's job is only to composite the real capture onto a clean 1600×900 canvas with your brand background.

**Before each one: crop out all browser chrome (address bar, tabs, OS taskbar/dock) and any desktop background — no PII anywhere (use test data, not a real customer's name/email). Chrome's device toolbar (Cmd/Ctrl+Shift+M) is the easiest way to get a clean crop at a fixed size.**

---

## 1. Hero — chat answering a question, model switcher visible

**What to capture:** Open Rendal on your dev store, go to the Chat tab, pick a model from the switcher (e.g. Claude Sonnet 5) so the dropdown visibly shows a model name, then ask something like "What are my best-selling products this month?" and let it fully answer. Screenshot once the reply is showing, cropped to just the chat panel — no Shopify main sidebar nav if you can crop it out, no browser chrome, no real customer names in the reply (use test-store data).

```
Reference image: [attached — hero chat screenshot]
What to keep exactly the same: every pixel of the screenshot itself — all text, the model switcher, the chat bubbles, colors, layout. Do not redraw, re-letter, or paraphrase any text inside it.
What to change: place the screenshot inside a 1600x900 landscape canvas on a void-black (#0A0A0F) background with a soft electric-blue (#2D6CFF) ambient glow behind it, matching a premium SaaS product page. Add one short headline in a bold geometric sans-serif (Space Grotesk style) above or beside the screenshot: "Your AI co-founder, right inside Shopify."
How much to change: significant on the background/frame/headline, zero on the screenshot content itself.
Style consistency: dark, technical, confident SaaS aesthetic — no gradients outside navy/black/signal-blue, no stock-photo people, no clutter.
Negative prompt: no invented UI elements, no altered or re-rendered text inside the screenshot, no warping, no browser chrome, no watermark, no blur on the screenshot area.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (54 chars): `AI co-founder answers a sales question in Shopify chat`

---

## 2. Approval — the review card before a change saves

**What to capture:** In the same chat, ask it to make a change (e.g. "Raise the price of [test product] to $24.99"). Wait for the proposed-change review card to appear with Approve/Discard visible — screenshot before clicking either one, so the pending state is clearly shown.

```
Reference image: [attached — approval card screenshot]
What to keep exactly the same: the review card's fields, the price diff, the Approve/Discard buttons, all text exactly as shown.
What to change: same 1600x900 void-black canvas with signal-blue glow as the hero image, for visual consistency across the listing. Add a short headline: "Nothing saves without your approval."
How much to change: significant on background/frame/headline, zero on the screenshot content.
Style consistency: identical brand treatment to image 1 — same colors, same headline font, same canvas size.
Negative prompt: no invented UI, no altered text or numbers inside the screenshot, no browser chrome, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (63 chars): `Review and approve a price change before it saves to your store`

---

## 3. Skills — custom instructions triggered with "/"

**What to capture:** Go to the Skills tab. If you don't have one uploaded yet, upload a sample .md skill file first so the list shows at least one real row (name + trigger). Screenshot the page with that list visible.

```
Reference image: [attached — skills page screenshot]
What to keep exactly the same: the skills table, the upload control, all visible text.
What to change: same 1600x900 canvas/background treatment as images 1-2. Headline: "Teach it your playbook, trigger it with /."
How much to change: significant on background/frame/headline, zero on the screenshot content.
Style consistency: identical brand treatment to the previous two images.
Negative prompt: no invented UI, no altered filenames or text, no browser chrome, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (57 chars): `Upload a custom skill and trigger it with a slash command`

---

## 4. Plans — choose or change your plan, right in the app

**What to capture:** Go to the Usage tab. If a plan is already active, the page shows "Change plan" with all four tier cards (Starter/Growth/Scale/Founder) and their price/credits/features, with your current plan outlined. Screenshot that section — crop to the plan cards grid, not the whole page if it's long. If no plan is selected yet on your test store, the same section shows "Choose a plan to get started," which works just as well for this shot since it's arguably more compelling to a visitor who hasn't installed yet.

```
Reference image: [attached — Usage page plan-chooser screenshot]
What to keep exactly the same: every plan card's name, price, credit count, and feature bullets exactly as shown — do not alter any number or word.
What to change: same 1600x900 void-black/signal-blue canvas as the other images. Headline: "See every plan, switch anytime — no support ticket required."
How much to change: significant on background/frame/headline, zero on the screenshot content.
Style consistency: identical brand treatment to the previous images, so all 5 read as one consistent set.
Negative prompt: no invented or altered prices, credit numbers, or feature text, no browser chrome, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (58 chars): `Compare plans and switch anytime, right inside the app`

---

## 5. Mobile — the chat on a phone-sized screen

**What to capture:** Using Chrome's device toolbar (or a real phone), set the viewport to a phone size (e.g. iPhone 14 Pro, ~390×844), open the Chat tab, and screenshot it there. Crop to just the phone-width content, no browser chrome.

```
Reference image: [attached — mobile chat screenshot]
What to keep exactly the same: every pixel of the mobile screenshot.
What to change: place the mobile screenshot within the same 1600x900 void-black/signal-blue canvas, sized to sit comfortably as a portrait panel within the landscape frame (do not stretch it to fill the full width). Headline: "Just as sharp on the go."
How much to change: significant on background/frame/headline, zero on the screenshot content.
Style consistency: identical brand treatment to the previous four images, so all 5 read as one consistent set.
Negative prompt: no stretching or distorting the phone screenshot's aspect ratio, no invented UI, no browser or OS chrome, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (40 chars): `Rendal's chat running on a mobile device`

---

If Nano Banana warps or re-renders text inside the screenshot on any attempt, switch that one image to **Seedream 4.0** or **FLUX.2 Max** instead — both also handle reference-editing well and may preserve fine UI text more reliably.

Reminder before you capture: no real customer names, emails, or order details anywhere in any screenshot — use test-store data only, per Shopify's PII rule.
