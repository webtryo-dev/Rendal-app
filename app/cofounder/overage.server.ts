import prisma from "../db.server";
import type { AdminContext } from "./tools.server";
import {
  APP_EVENTS_AUTH_URL,
  APP_EVENTS_URL,
  EXTRA_CREDIT_METER_HANDLE,
  RETAIL_CREDITS_PER_DOLLAR,
  planConfig,
} from "./pricing.server";

// ---------------------------------------------------------------------------
// Self-enforced overage spending ceiling.
//
// Shopify App Pricing (App Events API) has NO native spending cap — nothing
// the merchant pre-approves stops billing automatically. So the ceiling
// lives here: before any usage event is sent (and before any new billable
// model call), the shop's cumulative overage dollars for the current
// billing period are checked against its plan's ceiling.
// ---------------------------------------------------------------------------

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // rolling 30-day billing period

type ShopRow = {
  id: string;
  plan: string;
  credit_balance: bigint;
  billing_period_start: Date;
};

/**
 * Advance billing_period_start in whole 30-day steps when a period has
 * elapsed. The overage total lives on the usage_logs row keyed by
 * (shop_id, billing_period_start), so a fresh period starts at zero
 * automatically — advancing the anchor IS the reset.
 */
export async function rolloverBillingPeriod<T extends ShopRow>(shop: T): Promise<T> {
  const elapsed = Date.now() - shop.billing_period_start.getTime();
  if (elapsed < PERIOD_MS) return shop;
  const periods = Math.floor(elapsed / PERIOD_MS);
  const newStart = new Date(shop.billing_period_start.getTime() + periods * PERIOD_MS);
  const updated = await prisma.shops.update({
    where: { id: shop.id },
    data: { billing_period_start: newStart, updated_at: new Date() },
  });
  return { ...shop, ...updated };
}

export interface OverageStatus {
  /** True when further billable actions must be blocked. */
  blocked: boolean;
  overageDollars: number;
  ceilingUsd: number;
  planLabel: string;
  /** When the next billing period (and standard credits) begins. */
  resumesAt: Date;
}

export async function getOverageStatus(shop: ShopRow): Promise<OverageStatus> {
  const cfg = planConfig(shop.plan);
  const log = await prisma.usage_logs.findUnique({
    where: {
      shop_id_billing_period_start: {
        shop_id: shop.id,
        billing_period_start: shop.billing_period_start,
      },
    },
    select: { overage_dollars_billed: true },
  });
  const overageDollars = Number(log?.overage_dollars_billed ?? 0);
  const inOverage = shop.credit_balance <= 0n;
  return {
    blocked: inOverage && overageDollars >= cfg.overageCeilingUsd,
    overageDollars,
    ceilingUsd: cfg.overageCeilingUsd,
    planLabel: cfg.label,
    resumesAt: new Date(shop.billing_period_start.getTime() + PERIOD_MS),
  };
}

// ---------------------------------------------------------------------------
// App Events API (REST). Auth: client-credentials JWT (1h expiry), then
// POST the event with the meter handle and unit count in attributes.value.
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function appEventsToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const response = await fetch(APP_EVENTS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) {
    throw new Error(`App Events auth failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

const shopGidCache = new Map<string, string>();

async function fetchShopGid(admin: AdminContext, shopId: string): Promise<string> {
  const cached = shopGidCache.get(shopId);
  if (cached) return cached;
  const response = await admin.graphql(`#graphql
    query cofounderShopId {
      shop {
        id
      }
    }`);
  const json = await response.json();
  const gid = json.data?.shop?.id as string | undefined;
  if (!gid) throw new Error("Could not resolve shop GID for App Events.");
  shopGidCache.set(shopId, gid);
  return gid;
}

export interface OverageReport {
  sent: boolean;
  dollars: number;
  /** Present when the event was withheld (ceiling) or the send failed. */
  reason?: "ceiling" | "send_failed";
}

/**
 * Bill overage credits through the Partner Dashboard meter. Checks the
 * ceiling BEFORE sending: if this event would cross it, nothing is sent
 * (the caller has already been prevented from starting new billable work
 * by getOverageStatus, so a withheld boundary event is absorbed by us,
 * never billed to the merchant). Accrues the running total only when
 * Shopify accepts the event.
 */
export async function reportOverage(
  admin: AdminContext,
  shop: ShopRow,
  overageCredits: bigint,
): Promise<OverageReport> {
  const dollars = Number(overageCredits) / RETAIL_CREDITS_PER_DOLLAR;
  if (overageCredits <= 0n) return { sent: false, dollars: 0 };

  const cfg = planConfig(shop.plan);
  const status = await getOverageStatus(shop);
  if (status.overageDollars + dollars > cfg.overageCeilingUsd) {
    console.warn(
      `[overage] withheld app event for ${shop.id}: ${dollars.toFixed(4)}$ would cross the ${cfg.overageCeilingUsd}$ ceiling (at ${status.overageDollars.toFixed(4)}$).`,
    );
    return { sent: false, dollars, reason: "ceiling" };
  }

  try {
    const [token, shopGid] = await Promise.all([
      appEventsToken(),
      fetchShopGid(admin, shop.id),
    ]);
    const response = await fetch(APP_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shop_id: shopGid,
        event_handle: EXTRA_CREDIT_METER_HANDLE,
        timestamp: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
        attributes: { value: Number(overageCredits) },
      }),
    });
    if (!response.ok) {
      throw new Error(`App Events send failed (${response.status}): ${await response.text()}`);
    }
  } catch (error) {
    // Never bill-track what Shopify didn't accept; surface loudly in logs.
    console.error(`[overage] app event send failed for ${shop.id}:`, error);
    return { sent: false, dollars, reason: "send_failed" };
  }

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
      overage_dollars_billed: dollars.toFixed(6),
    },
    update: {
      overage_dollars_billed: { increment: dollars.toFixed(6) },
      updated_at: new Date(),
    },
  });
  return { sent: true, dollars };
}
