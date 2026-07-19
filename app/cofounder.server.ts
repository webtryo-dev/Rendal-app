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
  prepareThemeWrite,
  summarizeWrite,
  type AdminContext,
} from "./cofounder/tools.server";
import {
  MODEL_CATALOG,
  type ChatTurnResult,
  type NeutralMessage,
  type NeutralToolCall,
  type PendingWrite,
  type UsageEntry,
} from "./cofounder/types";
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
      "You help with strategy, marketing, and day-to-day store operations, and you can read store data (products, inventory, shipping setup, discounts) and propose changes with the provided tools.",
      "Reads run automatically. Write tools (update_product, set_inventory_quantity, create_discount_code, update_theme_file) only PROPOSE an action: the merchant sees an approval dialog and may decline — never claim an action happened until you receive a tool result saying so.",
      "Propose at most one gated action at a time.",
      "You can read and edit theme code (Liquid, JSON templates, CSS, JS). Always read_theme_file before proposing an edit, and pass the COMPLETE new file content to update_theme_file — the merchant reviews a line-level diff. Editing the live (MAIN) theme is allowed but the merchant is warned; prefer an unpublished theme when one exists and the merchant hasn't specified.",
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

async function runLoop(
  admin: AdminContext,
  shopDomain: string,
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
      if (WRITE_TOOL_NAMES.has(call.name)) {
        if (!pending) {
          let summary: string[];
          let details: Partial<PendingWrite> = {};
          if (call.name === "update_theme_file") {
            // Theme edits get a real line-level diff, not a bare summary.
            const theme = await prepareThemeWrite(admin, call.input);
            summary = theme.summary;
            details = { diff: theme.diff, warning: theme.warning };
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
  modelId: string,
  messages: NeutralMessage[],
): Promise<ChatTurnResult> {
  try {
    return await withDbRetry(() => runLoop(admin, shopDomain, modelId, messages));
  } catch (error) {
    return { status: "error", messages, errorMessage: describeAdapterError(error), usage: [] };
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
  modelId: string,
  messages: NeutralMessage[],
  pendingWrite: PendingWrite,
  approved: boolean,
): Promise<ChatTurnResult> {
  try {
    const result = approved
      ? await executeWriteTool(admin, pendingWrite.toolName, pendingWrite.input)
      : {
          content:
            "The merchant declined this change in the approval dialog. Do not retry it unless they ask again.",
          isError: false,
        };

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
    return await runLoop(admin, shopDomain, modelId, msgs);
  } catch (error) {
    return { status: "error", messages, errorMessage: describeAdapterError(error), usage: [] };
  }
}
