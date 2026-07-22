import prisma from "../db.server";
import type { AdminContext } from "./tools.server";
import { reportOverage } from "./overage.server";
import { REAL_COST_CREDIT_RATE } from "./pricing.server";
import type { ProviderId, UsageEntry } from "./types";

// ---------------------------------------------------------------------------
// Credits deducted = real_api_cost_usd * REAL_COST_CREDIT_RATE (250,000 —
// the 50,000 credits/$1 retail rate with the 5x markup applied; see
// pricing.server.ts). Prices are USD per 1M tokens (fetched from provider
// pricing pages 2026-07-14; Gemini 3.1 Pro uses its <=200k-token tier).
// ---------------------------------------------------------------------------

const CREDITS_PER_USD = REAL_COST_CREDIT_RATE;

interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Image-generation rates (gpt-image-2), USD per 1M tokens. */
  imageInputPerMTok?: number;
  cachedImageInputPerMTok?: number;
  imageOutputPerMTok?: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  // gpt-image-2 (Images API). Verified against OpenAI pricing 2026-07-20:
  // text input $5, image input $8, cached image input $2, image output $30 / 1M.
  "gpt-image-2": {
    inputPerMTok: 5,
    outputPerMTok: 0,
    imageInputPerMTok: 8,
    cachedImageInputPerMTok: 2,
    imageOutputPerMTok: 30,
  },
};

/** DB check constraint vocabulary for chat_messages/credit_ledger. */
export function dbProvider(provider: ProviderId): string {
  return provider === "claude" ? "anthropic" : provider === "gpt" ? "openai" : "google";
}

export type { UsageEntry };

export function costUsd(entry: UsageEntry): number {
  const price = MODEL_PRICES[entry.modelId] ?? { inputPerMTok: 10, outputPerMTok: 50 };
  return (
    (entry.inputTokens / 1_000_000) * price.inputPerMTok +
    (entry.outputTokens / 1_000_000) * price.outputPerMTok +
    ((entry.imageInputTokens ?? 0) / 1_000_000) * (price.imageInputPerMTok ?? 0) +
    ((entry.cachedImageInputTokens ?? 0) / 1_000_000) * (price.cachedImageInputPerMTok ?? 0) +
    ((entry.imageOutputTokens ?? 0) / 1_000_000) * (price.imageOutputPerMTok ?? 0)
  );
}

/**
 * Write the per-call audit trail, deduct credits from the shop's balance,
 * and roll up the billing-period aggregate. Called once per chat turn with
 * every model call the turn made.
 */
export async function recordUsage(
  shop: { id: string; plan: string; credit_balance: bigint; billing_period_start: Date },
  entries: UsageEntry[],
  chatMessageId: string | null,
  admin?: AdminContext,
): Promise<void> {
  if (entries.length === 0) return;

  let totalCredits = 0n;
  let totalCost = 0;

  for (const entry of entries) {
    const cost = costUsd(entry);
    const credits = BigInt(Math.ceil(cost * CREDITS_PER_USD));
    totalCredits += credits;
    totalCost += cost;
    await prisma.credit_ledger.create({
      data: {
        shop_id: shop.id,
        chat_message_id: chatMessageId,
        model_provider: dbProvider(entry.provider),
        model_name: entry.modelId,
        // Image-generation token categories are folded into the audit columns
        // (their distinct rates were already applied in costUsd above).
        input_tokens:
          entry.inputTokens + (entry.imageInputTokens ?? 0) + (entry.cachedImageInputTokens ?? 0),
        output_tokens: entry.outputTokens + (entry.imageOutputTokens ?? 0),
        real_cost_usd: cost.toFixed(6),
        credits_deducted: credits,
      },
    });
  }

  await prisma.shops.update({
    where: { id: shop.id },
    data: { credit_balance: { decrement: totalCredits }, updated_at: new Date() },
  });

  await prisma.usage_logs.upsert({
    where: {
      shop_id_billing_period_start: {
        shop_id: shop.id,
        billing_period_start: shop.billing_period_start,
      },
    },
    create: {
      shop_id: shop.id,
      billing_period_start: shop.billing_period_start,
      total_credits_used: totalCredits,
      total_real_cost_usd: totalCost.toFixed(6),
      message_count: 1,
    },
    update: {
      total_credits_used: { increment: totalCredits },
      total_real_cost_usd: { increment: totalCost.toFixed(6) },
      message_count: { increment: 1 },
      updated_at: new Date(),
    },
  });

  // Overage: the portion of this turn's credits not covered by the shop's
  // remaining balance is billed through the Partner Dashboard meter (App
  // Events API), ceiling-checked inside reportOverage.
  if (admin) {
    const balanceBefore = shop.credit_balance;
    const covered = balanceBefore > 0n ? (balanceBefore < totalCredits ? balanceBefore : totalCredits) : 0n;
    const overageCredits = totalCredits - covered;
    if (overageCredits > 0n) {
      await reportOverage(admin, shop, overageCredits);
    }
  }
}
