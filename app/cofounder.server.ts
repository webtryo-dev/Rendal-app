import {
  ADAPTERS,
  describeAdapterError,
  toAssistantMessage,
} from "./cofounder/adapters.server";
import {
  TOOL_DEFS,
  WRITE_TOOL_NAMES,
  executeReadTool,
  executeWriteTool,
  generateCustomerCsv,
  generateImage,
  prepareDeleteProductWrite,
  prepareDiscountStatusWrite,
  prepareImageUploadWrite,
  prepareShopPolicyWrite,
  summarizeWrite,
  type AdminContext,
} from "./cofounder/tools.server";
import {
  MODEL_CATALOG,
  TOOL_STATUS_LABELS,
  type ChatTurnResult,
  type NeutralMessage,
  type NeutralToolCall,
  type PendingWrite,
  type UsageEntry,
} from "./cofounder/types";
import { isToolAllowed, requiredPlanForTool } from "./cofounder/capabilities.server";
import { planConfig } from "./cofounder/pricing.server";
import prisma from "./db.server";

export { MODEL_CATALOG };
export type { ChatTurnResult, NeutralMessage, PendingWrite };

interface MatchedSkill {
  name: string;
  instructions: string;
}

/**
 * Skills are invoked by typing /<trigger> in the message. Triggers are
 * re-derived server-side from the latest user message and matched against
 * the shop's saved skills; matched instructions are injected into this
 * turn's system prompt.
 */
async function matchSkills(shop: string, messages: NeutralMessage[]): Promise<MatchedSkill[]> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || lastUser.role !== "user") return [];
  const triggers = [...lastUser.text.matchAll(/(?:^|\s)\/([a-zA-Z0-9_-]+)/g)].map((m) =>
    m[1].toLowerCase(),
  );
  if (triggers.length === 0) return [];
  const skills = await prisma.skills.findMany({
    where: { shops: { shop_domain: shop }, trigger: { in: triggers } },
    select: { name: true, instructions: true },
  });
  return skills;
}

const MAX_TOOL_ITERATIONS = 8;

// Merchant-facing action phrase per plan-gated tool, used to build the plain
// in-chat "available on the X plan" message the model relays when a tool is
// blocked by the shop's plan (see capabilities.server.ts for the gating map).
// Anything not listed falls back to the raw tool name.
const GATED_TOOL_ACTIONS: Record<string, string> = {
  create_shipping_zone: "Managing shipping zones",
  update_shipping_zone: "Managing shipping zones",
  set_shipping_rate: "Managing shipping rates",
  create_bxgy_discount: "Creating buy-X-get-Y discounts",
  create_free_shipping_discount: "Creating free-shipping discounts",
  update_discount_code: "Editing discount codes",
  deactivate_discount_code: "Deactivating discount codes",
  delete_discount_code: "Deleting discount codes",
  generate_image: "Generating images",
  upload_image_to_files: "Uploading images to the store's Files",
  read_analytics: "Reading store analytics",
  list_customers: "Viewing customer records",
  generate_customer_csv: "Exporting customers to CSV",
  update_shop_policies: "Updating store policies",
};

/**
 * Plain, non-alarming message returned as a tool result when a tool is not
 * available on the shop's plan — same tone as the Protected Customer Data and
 * overage caveats. The model relays this to the merchant; the tool never runs.
 */
function planBlockMessage(toolName: string): string {
  const action = GATED_TOOL_ACTIONS[toolName] ?? `The ${toolName} action`;
  const requiredPlan = requiredPlanForTool(toolName);
  const planLabel = requiredPlan ? planConfig(requiredPlan).label : null;
  return planLabel
    ? `${action} is available on the ${planLabel} plan — the store's current plan doesn't include it, so nothing was run. Let the merchant know they can upgrade to unlock it, and don't retry it in this conversation.`
    : `${action} isn't available on the store's current plan, so nothing was run. Let the merchant know plainly, and don't retry it in this conversation.`;
}

/** Retry transient provider overload/unavailable errors with short backoff. */
async function completeWithRetry(
  adapter: (typeof ADAPTERS)[keyof typeof ADAPTERS],
  request: Parameters<(typeof ADAPTERS)["claude"]["complete"]>[0],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await adapter.complete(request);
    } catch (error) {
      lastError = error;
      const text = error instanceof Error ? error.message : String(error);
      const transient = /\b(503|529|UNAVAILABLE|overloaded|high demand)\b/i.test(text);
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function buildSystemPrompt(shopDomain: string, skills: MatchedSkill[]): string {
  const parts = [
    [
      `You are Rendal, the merchant's AI co-founder inside the Shopify admin for the store ${shopDomain}.`,
      "You help with strategy, marketing, and day-to-day store operations, and you can read store data (products, inventory, shipping setup, discounts, customers), read aggregated analytics — sales, traffic, and conversion — with ShopifyQL via read_analytics, export customers to a CSV the merchant can download (generate_customer_csv), fetch public web pages for research (fetch_url), and propose changes with the provided tools.",
      "Customer names, emails, phones and addresses are Protected Customer Data; if a customer read is denied, relay the short explanation you get back rather than guessing — and never paste a generated CSV's contents into the chat, just point the merchant to the download.",
      "You can read general store settings (get_shop_info) and propose replacing a legal policy — refund, privacy, shipping, or terms of service — with update_shop_policies, which the merchant approves via a before/after diff. Read the current policy first. Shopify's API does NOT let a third-party app configure taxes, payment providers, or other installed apps, so you cannot do those — say so plainly if asked rather than pretending.",
      "Reads run automatically. Write tools (update_product, set_inventory_quantity, create_discount_code) only PROPOSE an action: the merchant sees an approval dialog and may decline — never claim an action happened until you receive a tool result saying so.",
      "Propose at most one gated action at a time.",
      "You can READ theme code (Liquid, JSON templates, CSS, JS) to explain how the storefront works and diagnose theme issues, but you cannot modify or publish themes — Shopify does not permit this app to change theme files. If a merchant asks for a theme change, say plainly that theme editing isn't available here and suggest they or their designer make the change in the admin theme editor. Do not paste blocks of theme code for the merchant to copy in.",
      "You can generate images from a text prompt (generate_image) — mockups, banners, ad creative, logo concepts. The image is shown to the merchant. After generating, OFFER to save it to the store's Files (upload_image_to_files) and let the merchant approve; never upload without being asked.",
      "Be concise and practical. Use plain text (no markdown tables). When you list products, mention titles rather than raw GIDs.",
      "Merchants can invoke custom skills by typing /<trigger> in their message; when a skill section appears below, follow its instructions for this request.",
    ].join(" "),
  ];
  if (skills.length > 0) {
    parts.push(
      `The merchant invoked the following skill(s) for this request:\n\n${skills
        .map((skill) => `## Skill: ${skill.name}\n${skill.instructions}`)
        .join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Write the shop's live turn-status (polled by the chat UI). Fire-and-forget by
 * design: status bookkeeping must never block or fail the actual turn, so we
 * don't await it and swallow any error (including the column not existing yet
 * before the manual migration is applied). A missed write is self-healing — the
 * next step overwrites it, and a stale value is never shown because the client
 * only polls while a turn is running.
 */
function setShopStep(shopId: string, step: string | null): void {
  void prisma.shops.update({ where: { id: shopId }, data: { current_step: step } }).catch(() => {});
}

async function runLoop(
  admin: AdminContext,
  shopDomain: string,
  shopId: string,
  plan: string,
  modelId: string,
  messages: NeutralMessage[],
): Promise<ChatTurnResult> {
  const model = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model || !model.enabled) {
    return { status: "error", messages, errorMessage: `Model ${modelId} is not available yet.`, usage: [] };
  }
  const adapter = ADAPTERS[model.provider];
  const msgs = [...messages];
  const usage: UsageEntry[] = [];
  const skills = await matchSkills(shopDomain, msgs);

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    // Back to "Thinking…" before each model call — the merchant sees this
    // between tool steps too (e.g. after a read result comes back).
    setShopStep(shopId, "Thinking…");
    const response = await completeWithRetry(adapter, {
      model,
      system: buildSystemPrompt(shopDomain, skills),
      messages: msgs,
      tools: TOOL_DEFS,
    });
    usage.push({
      provider: model.provider,
      modelId: model.id,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });

    if (response.refusal) {
      return {
        status: "refusal",
        messages: msgs,
        errorMessage: `${response.servedByLabel} declined this request. Try rephrasing, or switch models.`,
        usage,
      };
    }

    msgs.push(toAssistantMessage(model, response));

    if (response.toolCalls.length === 0) {
      return { status: "done", messages: msgs, usage };
    }

    // Execute reads immediately; pause on the first gated store write. Any
    // extra gated calls in the same turn get a "not executed" result so every
    // call is answered before continuing.
    let pending: PendingWrite | undefined;
    for (const call of response.toolCalls) {
      // Plan gating runs on every tool call, unconditionally, before any read
      // or write is dispatched — the model's judgment is never the only thing
      // between the shop and a tool its plan doesn't include. Blocked calls get
      // a plain in-chat message the model relays; nothing is executed.
      if (!isToolAllowed(plan, call.name)) {
        msgs.push(toolMessage(call, planBlockMessage(call.name), false));
        continue;
      }
      // Surface which step is running now (e.g. "Searching products…").
      setShopStep(shopId, TOOL_STATUS_LABELS[call.name] ?? `Running ${call.name}…`);
      if (WRITE_TOOL_NAMES.has(call.name)) {
        if (!pending) {
          let summary: string[];
          let details: Partial<PendingWrite> = {};
          if (call.name === "delete_product") {
            // Deletions show server-verified title/id/status, never model copy.
            const prep = await prepareDeleteProductWrite(admin, call.input);
            summary = prep.summary;
            details = { warning: prep.warning };
          } else if (
            call.name === "deactivate_discount_code" ||
            call.name === "delete_discount_code"
          ) {
            // Show the discount's server-verified code + status before approval.
            const prep = await prepareDiscountStatusWrite(admin, call.name, call.input);
            summary = prep.summary;
            details = { warning: prep.warning };
          } else if (call.name === "upload_image_to_files") {
            // Show the actual generated image as a preview before it's saved.
            const prep = await prepareImageUploadWrite(shopId, call.input);
            summary = prep.summary;
            details = { warning: prep.warning, previewImageId: prep.previewImageId };
          } else if (call.name === "update_shop_policies") {
            // Policy edits get a real before/after diff of the full text.
            const prep = await prepareShopPolicyWrite(admin, call.input);
            summary = prep.summary;
            details = { diff: prep.diff, warning: prep.warning };
          } else {
            summary = summarizeWrite(call.name, call.input);
          }
          pending = {
            toolUseId: call.id,
            toolName: call.name,
            input: call.input,
            summary,
            syntheticId: call.syntheticId,
            ...details,
          };
        } else {
          msgs.push(toolMessage(call, "Not executed: only one gated action can be proposed at a time. Propose it again after the current one is resolved.", true));
        }
      } else if (call.name === "generate_image") {
        // Image generation calls a paid external API and produces bytes we
        // store server-side; it's metered through the same credit ledger as
        // chat. The tool result carries only a small imageId — never the
        // base64 — so the model's context stays lean.
        const gen = await generateImage(call.input);
        if (gen.usage) usage.push(gen.usage);
        if (gen.isError || !gen.image) {
          msgs.push(toolMessage(call, gen.errorContent ?? "Image generation failed.", true));
        } else {
          const row = await prisma.generated_images.create({
            data: {
              shop_id: shopId,
              prompt: gen.image.prompt,
              mime_type: gen.image.mimeType,
              data: gen.image.base64,
              width: gen.image.width,
              height: gen.image.height,
            },
          });
          msgs.push(
            toolMessage(
              call,
              JSON.stringify({
                imageId: row.id,
                mimeType: gen.image.mimeType,
                width: gen.image.width,
                height: gen.image.height,
                status: "generated",
                note: "The image is now shown to the merchant in the chat. If they want it saved to their store's Files, call upload_image_to_files with this imageId (it goes through merchant approval with a preview).",
              }),
              false,
            ),
          );
        }
      } else if (call.name === "generate_customer_csv") {
        // Produces a PII file held server-side with a 24h expiry. The tool
        // result carries only a reference (id/filename/row count) — never the
        // CSV rows — so customer PII never enters the model context or chat
        // history. The bytes are served by the /app/exports/:id route.
        const gen = await generateCustomerCsv(admin, call.input);
        if (gen.isError || gen.csv === undefined) {
          msgs.push(toolMessage(call, gen.errorContent ?? "Customer export failed.", true));
        } else {
          // Opportunistically purge anything already past its 24h window.
          await prisma.customer_exports.deleteMany({ where: { expires_at: { lt: new Date() } } });
          const filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
          const row = await prisma.customer_exports.create({
            data: {
              shop_id: shopId,
              filename,
              data: gen.csv,
              row_count: gen.rowCount ?? 0,
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
          msgs.push(
            toolMessage(
              call,
              JSON.stringify({
                exportId: row.id,
                filename,
                rowCount: gen.rowCount ?? 0,
                truncated: gen.truncated ?? false,
                expiresInHours: 24,
                status: "ready",
                note: `A download link for this CSV is shown to the merchant in the chat; it expires in 24 hours.${
                  gen.truncated ? ` Only the first ${gen.rowCount} customers were included (export cap reached).` : ""
                } Do not restate customer contact details in your reply.`,
              }),
              false,
            ),
          );
        }
      } else {
        const result = await executeReadTool(admin, call.name, call.input);
        msgs.push(toolMessage(call, result.content, result.isError));
      }
    }

    if (pending) {
      return { status: "pending_write", messages: msgs, pendingWrite: pending, usage };
    }
  }

  return {
    status: "error",
    messages: msgs,
    errorMessage: "The assistant used too many tool calls in one turn. Try a more specific request.",
    usage,
  };
}

function toolMessage(call: NeutralToolCall, content: string, isError: boolean): NeutralMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
    syntheticId: call.syntheticId,
  };
}

/** The Supabase pooler occasionally drops connections — retry once. */
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/Can't reach database server/i.test(text)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return fn();
  }
}

export async function runChatTurn(
  admin: AdminContext,
  shopDomain: string,
  shopId: string,
  plan: string,
  modelId: string,
  messages: NeutralMessage[],
): Promise<ChatTurnResult> {
  try {
    return await withDbRetry(() => runLoop(admin, shopDomain, shopId, plan, modelId, messages));
  } catch (error) {
    return { status: "error", messages, errorMessage: describeAdapterError(error), usage: [] };
  } finally {
    // Turn over (done, paused for approval, refused, or errored) — clear the
    // live step so the UI stops showing progress.
    setShopStep(shopId, null);
  }
}

/**
 * Resolve a pending write after the merchant clicked Approve or Cancel in
 * the confirmation modal, then let the model continue the turn. This is the
 * ONLY code path that executes a write tool.
 */
export async function resolveWrite(
  admin: AdminContext,
  shopDomain: string,
  shopId: string,
  plan: string,
  modelId: string,
  messages: NeutralMessage[],
  pendingWrite: PendingWrite,
  approved: boolean,
): Promise<ChatTurnResult> {
  try {
    // Re-check the plan on the actual dispatch, not just at proposal time — a
    // plan could change between a write being proposed and approved, and this
    // is the only path that executes a write tool.
    const result = !approved
      ? {
          content:
            "The merchant declined this change in the approval dialog. Do not retry it unless they ask again.",
          isError: false,
        }
      : isToolAllowed(plan, pendingWrite.toolName)
        ? await executeWriteTool(admin, pendingWrite.toolName, pendingWrite.input, shopId)
        : { content: planBlockMessage(pendingWrite.toolName), isError: false };

    const msgs: NeutralMessage[] = [
      ...messages,
      {
        role: "tool",
        toolCallId: pendingWrite.toolUseId,
        toolName: pendingWrite.toolName,
        content: result.content,
        isError: result.isError,
        syntheticId: pendingWrite.syntheticId,
      },
    ];
    return await runLoop(admin, shopDomain, shopId, plan, modelId, msgs);
  } catch (error) {
    return { status: "error", messages, errorMessage: describeAdapterError(error), usage: [] };
  } finally {
    setShopStep(shopId, null);
  }
}
