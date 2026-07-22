# Rendal — App Store Screenshot Prompts (Higgsfield), v3 — desktop marketing-banner style

New direction based on the reference banners you shared (AppLovin Ads, Code Creation Labs, Disputifier, etc.): bold headline on the left, real app screenshot presented as a clean floating desktop card on the right (rounded corners, soft shadow, no browser chrome, no phone frame), logo top-left, colorful/dark background. All 5 are desktop-style now — no phone mockup.

Rendal's own brand palette is used instead of copying a competitor's exact colors, so the set still reads as your brand: void black `#0A0A0F`, navy `#0B1E3D`/`#0F2650`, signal blue `#2D6CFF`, glow blue `#5B8DFF`, offwhite `#F5F6FA`. Headline font: Space Grotesk (bold, geometric). Each prompt below keeps your real screenshot's pixels untouched — Higgsfield only builds the banner around it.

**Before each capture: crop out browser chrome and desktop background, no real customer PII (use test-store data).**

---

## 1. Hero — chat answering a question

**What to capture:** Chat tab, model switcher showing a model name (e.g. Claude Sonnet 5), a real answered question like "What are my best-selling products this month?" Crop tightly to the chat panel.

```
Reference image: [attached — hero chat screenshot]
What to keep exactly the same: every pixel of the screenshot — all text, the model switcher, chat bubbles, colors, layout. Do not redraw or paraphrase any text inside it.
What to change: build a 1600x900 desktop marketing banner. Background: void-black (#0A0A0F) to navy (#0F2650) gradient. Top-left: small square logo mark + "Rendal" wordmark in white. Left-middle: large bold two-line headline in Space Grotesk, white text: "Your AI co-founder, right inside Shopify." Right side: the attached screenshot presented as a clean floating card — rounded corners (~16px), soft drop shadow, no phone frame, no browser chrome — angled slightly or bleeding off the right edge of the canvas for depth, similar to how a dashboard screenshot is presented as a floating panel in a SaaS product-launch banner.
How much to change: significant on background/logo/headline/card framing, zero on the screenshot's own content.
Style consistency: dark, confident, technical SaaS aesthetic — no stock photos of people, no clutter, one accent color (signal blue) used sparingly for glow/highlights.
Negative prompt: no invented UI elements, no altered or re-rendered text inside the screenshot, no browser chrome, no phone/mobile frame, no watermark, no blur on the screenshot card itself.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (54 chars): `AI co-founder answers a sales question in Shopify chat`

---

## 2. Approval — nothing saves without your OK

**What to capture:** Ask it to change something (e.g. raise a test product's price), screenshot the pending approval card before clicking Approve/Discard.

```
Reference image: [attached — approval card screenshot]
What to keep exactly the same: the review card's fields, price diff, Approve/Discard buttons, all text exactly as shown.
What to change: same 1600x900 banner treatment as image 1 — void-black/navy gradient background, logo top-left, floating card on the right showing the screenshot. Headline (Space Grotesk, white, left-middle): "Nothing saves without your approval."
How much to change: significant on background/logo/headline/card framing, zero on the screenshot content.
Style consistency: identical brand treatment to image 1 — same colors, same card style, same canvas size.
Negative prompt: no invented UI, no altered text or numbers inside the screenshot, no browser chrome, no phone frame, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (63 chars): `Review and approve a price change before it saves to your store`

---

## 3. Skills — teach it your playbook

**What to capture:** Skills tab with at least one uploaded skill visible (name + trigger).

```
Reference image: [attached — skills page screenshot]
What to keep exactly the same: the skills table, upload control, all visible text.
What to change: same 1600x900 banner treatment as images 1-2. Headline: "Teach it your playbook, trigger it with /."
How much to change: significant on background/logo/headline/card framing, zero on the screenshot content.
Style consistency: identical brand treatment to the previous two images.
Negative prompt: no invented UI, no altered filenames or text, no browser chrome, no phone frame, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (57 chars): `Upload a custom skill and trigger it with a slash command`

---

## 4. Plans — switch anytime, no lock-in

**What to capture:** Usage page's plan section — either "Change plan" (all 4 tier cards, current plan outlined) or "Choose a plan to get started" if no plan is active yet on your test store. Crop to the plan cards grid.

```
Reference image: [attached — Usage page plan-chooser screenshot]
What to keep exactly the same: every plan card's name, price, credit count, and feature bullets exactly as shown.
What to change: same 1600x900 banner treatment. Headline: "See every plan, switch anytime — no support ticket required."
How much to change: significant on background/logo/headline/card framing, zero on the screenshot content.
Style consistency: identical brand treatment to the previous images.
Negative prompt: no invented or altered prices, credit numbers, or feature text, no browser chrome, no phone frame, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (58 chars): `Compare plans and switch anytime, right inside the app`

---

## 5. Multi-model — Claude, GPT, and Gemini, one thread

**What to capture:** Open the model switcher dropdown mid-conversation so it visibly lists multiple providers (Claude / GPT / Gemini options), ideally with two different assistant replies in the same thread showing different model labels, so it's visually obvious you can switch models without starting over.

```
Reference image: [attached — model switcher screenshot]
What to keep exactly the same: the model switcher dropdown, model names/labels, chat bubbles, and any visible model-tier text — all exactly as shown.
What to change: same 1600x900 banner treatment. Headline: "Claude, GPT, or Gemini — switch models, same conversation."
How much to change: significant on background/logo/headline/card framing, zero on the screenshot content.
Style consistency: identical brand treatment to the previous four images, so all 5 read as one consistent set.
Negative prompt: no invented model names, no altered text, no browser chrome, no phone frame, no watermark.
```
Settings: Nano Banana, aspect ratio 16:9, quality 2K.
Alt text (52 chars): `Switch between Claude, GPT, and Gemini in one chat`

---

If Nano Banana warps or re-renders text inside the screenshot on any attempt, switch that one image to **Seedream 4.0** or **FLUX.2 Max** instead.

Reminder: no real customer names, emails, or order details anywhere — test-store data only.
