import prisma from "../db.server";
import type { ProviderId, UsageEntry } from "./types";

// ---------------------------------------------------------------------------
// Credits: $20 of subscription price = 1,000,000 credits (5x markup), so
// credits_to_deduct = real_api_cost_usd * 250,000.
// Prices are USD per 1M tokens (fetched from provider pricing pages 2026-07-14;
// Gemini 3.1 Pro uses its <=200k-token tier).
// ---------------------------------------------------------------------------

const CREDITS_PER_USD = 250_000;

const MODEL_PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
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
    (entry.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

/**
 * Write the per-call audit trail, deduct credits from the shop's balance,
 * and roll up the billing-period aggregate. Called once per chat turn with
 * every model call the turn made.
 */
export async function recordUsage(
  shop: { id: string; billing_period_start: Date },
  entries: UsageEntry[],
  chatMessageId: string | null,
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
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
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
}
