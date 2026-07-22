import { beforeEach, describe, expect, it, vi } from "vitest";
import { costUsd, dbProvider, recordUsage } from "./billing.server";
import type { UsageEntry } from "./types";
import type { AdminContext } from "./tools.server";
import prisma from "../db.server";
import { reportOverage } from "./overage.server";

vi.mock("../db.server", () => ({
  default: {
    credit_ledger: { create: vi.fn().mockResolvedValue({}) },
    shops: { update: vi.fn().mockResolvedValue({}) },
    usage_logs: { upsert: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("./overage.server", () => ({
  reportOverage: vi.fn().mockResolvedValue(undefined),
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedReportOverage = vi.mocked(reportOverage);

const admin = {} as AdminContext;

function makeShop(creditBalance: bigint) {
  return {
    id: "shop_1",
    plan: "growth",
    credit_balance: creditBalance,
    billing_period_start: new Date("2026-07-01T00:00:00Z"),
  };
}

/** claude-sonnet-5 at 1M in / 1M out: $3 + $15 = $18 with NO floating-point
 *  error (1.0 is exact), so credits = ceil(18 * 250,000) = 4,500,000 exactly —
 *  a clean number for the boundary assertions below. (Fractional token counts
 *  like 100k/20k produce float dust — 0.6000...01 — which recordUsage ceils
 *  up by one credit; that's accepted behavior, but boundaries are only
 *  testable where the arithmetic is exact.) */
const SONNET_ENTRY: UsageEntry = {
  provider: "claude",
  modelId: "claude-sonnet-5",
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
};
const SONNET_ENTRY_CREDITS = 4_500_000n;

describe("costUsd", () => {
  it("prices a Claude model (claude-sonnet-5: $3 in / $15 out per MTok)", () => {
    expect(
      costUsd({ provider: "claude", modelId: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(18, 10);
  });

  it("prices a GPT model (gpt-5.4: $2.5 in / $15 out per MTok)", () => {
    expect(
      costUsd({ provider: "gpt", modelId: "gpt-5.4", inputTokens: 2_000_000, outputTokens: 500_000 }),
    ).toBeCloseTo(12.5, 10);
  });

  it("prices a Gemini model (gemini-3.5-flash: $1.5 in / $9 out per MTok)", () => {
    expect(
      costUsd({ provider: "gemini", modelId: "gemini-3.5-flash", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(10.5, 10);
  });

  it("prices gpt-image-2 using every image-token field at its own rate", () => {
    // $5 text-in + $0 text-out + $8 image-in + $2 cached-image-in + $30 image-out
    expect(
      costUsd({
        provider: "gpt",
        modelId: "gpt-image-2",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000, // outputPerMTok is 0 for gpt-image-2
        imageInputTokens: 1_000_000,
        cachedImageInputTokens: 1_000_000,
        imageOutputTokens: 1_000_000,
      }),
    ).toBeCloseTo(45, 10);
  });

  it("ignores image-token fields for models without image rates", () => {
    expect(
      costUsd({
        provider: "claude",
        modelId: "claude-sonnet-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        imageInputTokens: 1_000_000,
        cachedImageInputTokens: 1_000_000,
        imageOutputTokens: 1_000_000,
      }),
    ).toBeCloseTo(3, 10);
  });

  it("falls back to $10/$50 per MTok for an unknown model id", () => {
    expect(
      costUsd({ provider: "gpt", modelId: "some-future-model", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(60, 10);
  });

  it("costs zero for zero tokens", () => {
    expect(costUsd({ provider: "claude", modelId: "claude-sonnet-5", inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("dbProvider", () => {
  it("maps provider ids to the DB check-constraint vocabulary", () => {
    expect(dbProvider("claude")).toBe("anthropic");
    expect(dbProvider("gpt")).toBe("openai");
    expect(dbProvider("gemini")).toBe("google");
  });
});

describe("recordUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing for an empty entry list", async () => {
    await recordUsage(makeShop(1_000_000n), [], null, admin);
    expect(mockedPrisma.credit_ledger.create).not.toHaveBeenCalled();
    expect(mockedPrisma.shops.update).not.toHaveBeenCalled();
    expect(mockedPrisma.usage_logs.upsert).not.toHaveBeenCalled();
    expect(mockedReportOverage).not.toHaveBeenCalled();
  });

  it("writes one ledger row per entry, folding image tokens into audit columns", async () => {
    const imageEntry: UsageEntry = {
      provider: "gpt",
      modelId: "gpt-image-2",
      inputTokens: 100,
      outputTokens: 10,
      imageInputTokens: 20,
      cachedImageInputTokens: 30,
      imageOutputTokens: 40,
    };
    await recordUsage(makeShop(10_000_000n), [SONNET_ENTRY, imageEntry], "msg_1", admin);

    expect(mockedPrisma.credit_ledger.create).toHaveBeenCalledTimes(2);
    const rows = mockedPrisma.credit_ledger.create.mock.calls.map((c) => c[0].data);
    expect(rows[0]).toMatchObject({
      shop_id: "shop_1",
      chat_message_id: "msg_1",
      model_provider: "anthropic",
      model_name: "claude-sonnet-5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      credits_deducted: SONNET_ENTRY_CREDITS,
    });
    expect(rows[1]).toMatchObject({
      model_provider: "openai",
      model_name: "gpt-image-2",
      input_tokens: 100 + 20 + 30, // text + image + cached image inputs folded
      output_tokens: 10 + 40, // text + image outputs folded
    });
  });

  it("decrements the shop balance by the summed credits and rolls up usage_logs", async () => {
    await recordUsage(makeShop(10_000_000n), [SONNET_ENTRY, SONNET_ENTRY], "msg_1", admin);

    expect(mockedPrisma.shops.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "shop_1" },
        data: expect.objectContaining({
          credit_balance: { decrement: SONNET_ENTRY_CREDITS * 2n },
        }),
      }),
    );
    expect(mockedPrisma.usage_logs.upsert).toHaveBeenCalledTimes(1);
    const upsert = mockedPrisma.usage_logs.upsert.mock.calls[0][0];
    expect(upsert.create).toMatchObject({ total_credits_used: SONNET_ENTRY_CREDITS * 2n, message_count: 1 });
    expect(upsert.update).toMatchObject({
      total_credits_used: { increment: SONNET_ENTRY_CREDITS * 2n },
      message_count: { increment: 1 },
    });
  });

  // --- overage-split boundaries -------------------------------------------

  it("reports no overage when the balance exactly covers the turn (boundary)", async () => {
    await recordUsage(makeShop(SONNET_ENTRY_CREDITS), [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).not.toHaveBeenCalled();
  });

  it("reports no overage when the balance more than covers the turn", async () => {
    await recordUsage(makeShop(SONNET_ENTRY_CREDITS + 1n), [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).not.toHaveBeenCalled();
  });

  it("reports the full turn as overage when the balance covers zero", async () => {
    const shop = makeShop(0n);
    await recordUsage(shop, [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).toHaveBeenCalledTimes(1);
    expect(mockedReportOverage).toHaveBeenCalledWith(admin, shop, SONNET_ENTRY_CREDITS);
  });

  it("treats a negative balance as covering zero, not as extra headroom", async () => {
    const shop = makeShop(-5n);
    await recordUsage(shop, [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).toHaveBeenCalledWith(admin, shop, SONNET_ENTRY_CREDITS);
  });

  it("reports only the uncovered remainder when the balance partially covers (boundary: 1 credit short)", async () => {
    const shop = makeShop(SONNET_ENTRY_CREDITS - 1n);
    await recordUsage(shop, [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).toHaveBeenCalledWith(admin, shop, 1n);
  });

  it("reports the uncovered remainder for a mid-range partial cover", async () => {
    const shop = makeShop(1_000_000n); // covers 1M of the 4.5M turn
    await recordUsage(shop, [SONNET_ENTRY], null, admin);
    expect(mockedReportOverage).toHaveBeenCalledWith(admin, shop, 3_500_000n);
  });

  it("never reports overage without an admin context", async () => {
    await recordUsage(makeShop(0n), [SONNET_ENTRY], null, undefined);
    expect(mockedReportOverage).not.toHaveBeenCalled();
    // The ledger/balance writes still happen.
    expect(mockedPrisma.credit_ledger.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.shops.update).toHaveBeenCalledTimes(1);
  });
});
