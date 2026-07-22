// ---------------------------------------------------------------------------
// Provider-neutral tool definitions — the aggregator. Each domain's schemas
// and implementations live together in its *.tools.server.ts file (products,
// shipping, discounts, theme, analytics/shop, customers, image, web); this
// barrel combines them and re-exports the same public surface the rest of the
// app has always consumed, so importers need zero changes.
//
// Write tools NEVER execute inside the chat loop — the orchestrator pauses
// and returns a pending_write for merchant approval (no silent writes, ever).
// ---------------------------------------------------------------------------

import { friendlyToolError, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";
import {
  PRODUCTS_TOOL_DEFS,
  PRODUCTS_WRITE_TOOL_NAMES,
  executeProductsReadTool,
  executeProductsWriteTool,
  summarizeProductsWrite,
} from "./products.tools.server";
import {
  SHIPPING_TOOL_DEFS,
  SHIPPING_WRITE_TOOL_NAMES,
  executeShippingReadTool,
  executeShippingWriteTool,
  summarizeShippingWrite,
} from "./shipping.tools.server";
import {
  DISCOUNTS_TOOL_DEFS,
  DISCOUNTS_WRITE_TOOL_NAMES,
  executeDiscountsReadTool,
  executeDiscountsWriteTool,
  summarizeDiscountsWrite,
} from "./discounts.tools.server";
import { THEME_TOOL_DEFS, executeThemeReadTool } from "./theme.tools.server";
import {
  ANALYTICS_TOOL_DEFS,
  ANALYTICS_WRITE_TOOL_NAMES,
  executeAnalyticsReadTool,
  executeAnalyticsWriteTool,
} from "./analytics.tools.server";
import {
  CUSTOMERS_TOOL_DEFS,
  CUSTOMERS_WRITE_TOOL_NAMES,
  executeCustomersReadTool,
} from "./customers.tools.server";
import {
  IMAGE_TOOL_DEFS,
  IMAGE_WRITE_TOOL_NAMES,
  executeImageWriteTool,
} from "./image.tools.server";
import { WEB_TOOL_DEFS, executeWebReadTool } from "./web.tools.server";

// Re-export the shared types and every domain export the rest of the app
// consumes, so existing `from "./cofounder/tools.server"` imports keep working.
export type { AdminContext, NeutralToolDef, ToolExecution } from "./shared.tools.server";
export { prepareDeleteProductWrite } from "./products.tools.server";
export { prepareDiscountStatusWrite } from "./discounts.tools.server";
export { prepareShopPolicyWrite } from "./analytics.tools.server";
export { generateCustomerCsv, type CustomerCsvResult } from "./customers.tools.server";
export {
  IMAGE_MODEL_ID,
  generateImage,
  prepareImageUploadWrite,
  type ImageGenResult,
} from "./image.tools.server";

const ALL_TOOL_DEFS: NeutralToolDef[] = [
  ...PRODUCTS_TOOL_DEFS,
  ...SHIPPING_TOOL_DEFS,
  ...DISCOUNTS_TOOL_DEFS,
  ...THEME_TOOL_DEFS,
  ...ANALYTICS_TOOL_DEFS,
  ...CUSTOMERS_TOOL_DEFS,
  ...IMAGE_TOOL_DEFS,
  ...WEB_TOOL_DEFS,
];

/**
 * The order the tools are presented to the model in — kept exactly as it was
 * before the per-domain split (domains were interleaved), so the serialized
 * tool list the providers see is byte-identical to the pre-split one.
 */
const TOOL_ORDER = [
  "search_products",
  "get_product",
  "get_inventory_levels",
  "fetch_url",
  "get_shipping_setup",
  "create_shipping_zone",
  "update_shipping_zone",
  "set_shipping_rate",
  "list_discounts",
  "read_analytics",
  "get_shop_info",
  "update_shop_policies",
  "list_customers",
  "generate_customer_csv",
  "create_product",
  "delete_product",
  "update_product",
  "set_inventory_quantity",
  "list_themes",
  "list_theme_files",
  "read_theme_file",
  "create_discount_code",
  "create_bxgy_discount",
  "create_free_shipping_discount",
  "update_discount_code",
  "deactivate_discount_code",
  "delete_discount_code",
  "generate_image",
  "upload_image_to_files",
  // Variant/option management (added after the pre-split snapshot; appended so
  // the original serialized tool-list prefix stays byte-identical).
  "create_product_variants",
  "update_variant",
  "delete_variant",
  "create_product_options",
  "update_product_option",
  "attach_product_images",
  "remove_product_image",
  "delete_shipping_zone",
  "delete_shipping_rate",
];

export const TOOL_DEFS: NeutralToolDef[] = TOOL_ORDER.map((name) => {
  const def = ALL_TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`Tool "${name}" is in TOOL_ORDER but no domain file defines it.`);
  return def;
});

export const WRITE_TOOL_NAMES = new Set([
  ...PRODUCTS_WRITE_TOOL_NAMES,
  ...SHIPPING_WRITE_TOOL_NAMES,
  ...DISCOUNTS_WRITE_TOOL_NAMES,
  ...ANALYTICS_WRITE_TOOL_NAMES,
  ...CUSTOMERS_WRITE_TOOL_NAMES,
  ...IMAGE_WRITE_TOOL_NAMES,
]);

export async function executeReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  try {
    const result =
      (await executeProductsReadTool(admin, name, input)) ??
      (await executeShippingReadTool(admin, name)) ??
      (await executeDiscountsReadTool(admin, name)) ??
      (await executeThemeReadTool(admin, name, input)) ??
      (await executeAnalyticsReadTool(admin, name, input)) ??
      (await executeCustomersReadTool(admin, name, input)) ??
      (await executeWebReadTool(name, input));
    return result ?? { content: `Unknown tool: ${name}`, isError: true };
  } catch (error) {
    return { content: friendlyToolError(name, error), isError: true };
  }
}

/** Executes an approved write. Only ever called after merchant approval. */
export async function executeWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
  shopId: string,
): Promise<ToolExecution> {
  try {
    const result =
      (await executeProductsWriteTool(admin, name, input, shopId)) ??
      (await executeShippingWriteTool(admin, name, input)) ??
      (await executeDiscountsWriteTool(admin, name, input)) ??
      (await executeAnalyticsWriteTool(admin, name, input)) ??
      (await executeImageWriteTool(admin, name, input, shopId));
    return result ?? { content: `Unknown write tool: ${name}`, isError: true };
  } catch (error) {
    return { content: friendlyToolError(name, error), isError: true };
  }
}

/** Human-readable summary of a proposed write, shown in the approval modal. */
export function summarizeWrite(name: string, input: Record<string, unknown>): string[] {
  return (
    summarizeProductsWrite(name, input) ??
    summarizeShippingWrite(name, input) ??
    summarizeDiscountsWrite(name, input) ?? [`${name}: ${JSON.stringify(input)}`]
  );
}
