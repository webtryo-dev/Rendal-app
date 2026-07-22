import { graphqlJson, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Discount tools: the list read plus the approval-gated create/update/
// deactivate/delete writes for the three code-discount kinds. Schemas and
// implementations live together; the barrel (tools.server.ts) aggregates and
// dispatches. All GraphQL validated against the 2026-07 Admin schema.
// ---------------------------------------------------------------------------

export const DISCOUNTS_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: "list_discounts",
    description:
      "List the store's discounts (code and automatic) with title, status, and summary. Call this when the merchant asks about existing discounts or before creating a new one (to avoid duplicate codes).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_discount_code",
    description:
      "Propose creating a percentage-off discount code that applies to all products for all customers. The merchant must approve before it is created. Check list_discounts first to avoid duplicate codes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Internal discount title shown in the admin." },
        code: { type: "string", description: "The code customers enter at checkout, e.g. SUMMER15." },
        percentage: { type: "number", description: "Percent off as a whole number between 1 and 100, e.g. 15 for 15% off." },
        endsAt: { type: "string", description: "Optional ISO 8601 end date/time. Omit for no end date." },
      },
      required: ["title", "code", "percentage"],
    },
  },
  {
    name: "create_bxgy_discount",
    description:
      "Propose creating a Buy X Get Y discount code (e.g. \"buy 2, get 1 free\"). The merchant must approve before it is created. Check list_discounts first to avoid duplicate codes. By default it applies to all products; pass a collection GID to scope the 'buys' and/or 'gets' side to one collection. Shopify may reject an all-products BXGY — if so, propose again scoped to a collection.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Internal discount title shown in the admin." },
        code: { type: "string", description: "The code customers enter at checkout, e.g. BOGO." },
        buysQuantity: { type: "integer", description: "How many qualifying items the customer must buy, e.g. 2." },
        getsQuantity: { type: "integer", description: "How many items the customer then gets discounted, e.g. 1." },
        getsPercentage: { type: "number", description: "Percent off the 'gets' items, 1-100. Defaults to 100 (free)." },
        buysCollectionId: { type: "string", description: "Optional Collection GID the 'buys' side is limited to. Omit for all products." },
        getsCollectionId: { type: "string", description: "Optional Collection GID the 'gets' side is limited to. Omit for all products." },
        endsAt: { type: "string", description: "Optional ISO 8601 end date/time. Omit for no end date." },
      },
      required: ["title", "code", "buysQuantity", "getsQuantity"],
    },
  },
  {
    name: "create_free_shipping_discount",
    description:
      "Propose creating a free-shipping discount code that applies to all customers and all shipping destinations. The merchant must approve before it is created. Check list_discounts first to avoid duplicate codes. Optionally require a minimum order subtotal.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Internal discount title shown in the admin." },
        code: { type: "string", description: "The code customers enter at checkout, e.g. FREESHIP." },
        minimumSubtotal: { type: "number", description: "Optional minimum order subtotal (shop currency) required to qualify. Omit for no minimum." },
        endsAt: { type: "string", description: "Optional ISO 8601 end date/time. Omit for no end date." },
      },
      required: ["title", "code"],
    },
  },
  {
    name: "update_discount_code",
    description:
      "Propose editing an existing basic (percentage-off) discount code created with create_discount_code. The merchant must approve first. Get the discount id from list_discounts. Only include the fields being changed. Changing the percentage re-scopes the discount to all products.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "DiscountCodeNode GID from list_discounts." },
        title: { type: "string", description: "New internal discount title." },
        code: { type: "string", description: "New code customers enter at checkout." },
        percentage: { type: "number", description: "New percent off as a whole number 1-100." },
        endsAt: { type: "string", description: "New ISO 8601 end date/time." },
      },
      required: ["id"],
    },
  },
  {
    name: "deactivate_discount_code",
    description:
      "Propose deactivating (turning off) an existing discount code so customers can no longer use it, without deleting it. The merchant sees the discount's code and current status and must approve first. Get the id from list_discounts.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "DiscountCodeNode GID from list_discounts." },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_discount_code",
    description:
      "Propose permanently deleting an existing discount code. The merchant sees the discount's code and current status in a confirmation dialog and must approve before anything is deleted. Get the id from list_discounts.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "DiscountCodeNode GID from list_discounts." },
      },
      required: ["id"],
    },
  },
];

export const DISCOUNTS_WRITE_TOOL_NAMES = [
  "create_discount_code",
  "create_bxgy_discount",
  "create_free_shipping_discount",
  "update_discount_code",
  "deactivate_discount_code",
  "delete_discount_code",
];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

const LIST_DISCOUNTS_QUERY = `#graphql
  query cofounderListDiscounts {
    discountNodes(first: 20) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
            summary
            codes(first: 1) { nodes { code } }
          }
          ... on DiscountAutomaticBasic {
            title
            status
            summary
          }
        }
      }
    }
  }`;

const GET_DISCOUNT_QUERY = `#graphql
  query cofounderGetDiscount($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountCodeBasic {
          title
          status
          codes(first: 1) { nodes { code } }
        }
        ... on DiscountCodeBxgy {
          title
          status
          codes(first: 1) { nodes { code } }
        }
        ... on DiscountCodeFreeShipping {
          title
          status
          codes(first: 1) { nodes { code } }
        }
        ... on DiscountAutomaticBasic { title status }
        ... on DiscountAutomaticBxgy { title status }
      }
    }
  }`;

const CREATE_DISCOUNT_MUTATION = `#graphql
  mutation cofounderCreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }`;

const CREATE_BXGY_DISCOUNT_MUTATION = `#graphql
  mutation cofounderCreateBxgyDiscount($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
    discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBxgy {
            title
            status
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }`;

const CREATE_FREE_SHIPPING_DISCOUNT_MUTATION = `#graphql
  mutation cofounderCreateFreeShippingDiscount($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeFreeShipping {
            title
            status
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }`;

const UPDATE_DISCOUNT_MUTATION = `#graphql
  mutation cofounderUpdateDiscountCode($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }`;

const DEACTIVATE_DISCOUNT_MUTATION = `#graphql
  mutation cofounderDeactivateDiscountCode($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic { title status }
          ... on DiscountCodeBxgy { title status }
          ... on DiscountCodeFreeShipping { title status }
        }
      }
      userErrors { field message }
    }
  }`;

const DELETE_DISCOUNT_MUTATION = `#graphql
  mutation cofounderDeleteDiscountCode($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }`;

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeDiscountsReadTool(
  admin: AdminContext,
  name: string,
): Promise<ToolExecution | null> {
  switch (name) {
    case "list_discounts": {
      const json = await graphqlJson(admin, LIST_DISCOUNTS_QUERY);
      return { content: JSON.stringify(json.data?.discountNodes?.nodes ?? []), isError: false };
    }
    default:
      return null;
  }
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeDiscountsWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "create_discount_code": {
      const percentage = Number(input.percentage);
      const json = await graphqlJson(admin, CREATE_DISCOUNT_MUTATION, {
        basicCodeDiscount: {
          title: input.title,
          code: input.code,
          startsAt: new Date().toISOString(),
          ...(input.endsAt ? { endsAt: input.endsAt } : {}),
          customerSelection: { all: true },
          customerGets: {
            value: { percentage: percentage / 100 },
            items: { all: true },
          },
        },
      });
      const userErrors = json.data?.discountCodeBasicCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Discount creation failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Discount created: ${JSON.stringify(json.data?.discountCodeBasicCreate?.codeDiscountNode)}`,
        isError: false,
      };
    }
    case "create_bxgy_discount": {
      const buysQuantity = Math.max(1, Math.round(Number(input.buysQuantity)));
      const getsQuantity = Math.max(1, Math.round(Number(input.getsQuantity)));
      const getsPercentage = input.getsPercentage === undefined ? 100 : Number(input.getsPercentage);
      const buysItems = input.buysCollectionId
        ? { collections: { add: [input.buysCollectionId] } }
        : { all: true };
      const getsItems = input.getsCollectionId
        ? { collections: { add: [input.getsCollectionId] } }
        : { all: true };
      const json = await graphqlJson(admin, CREATE_BXGY_DISCOUNT_MUTATION, {
        bxgyCodeDiscount: {
          title: input.title,
          code: input.code,
          startsAt: new Date().toISOString(),
          ...(input.endsAt ? { endsAt: input.endsAt } : {}),
          customerSelection: { all: true },
          customerBuys: {
            value: { quantity: String(buysQuantity) },
            items: buysItems,
          },
          customerGets: {
            value: {
              discountOnQuantity: {
                quantity: String(getsQuantity),
                effect: { percentage: getsPercentage / 100 },
              },
            },
            items: getsItems,
          },
        },
      });
      const userErrors = json.data?.discountCodeBxgyCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Discount creation failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Buy-X-get-Y discount created: ${JSON.stringify(json.data?.discountCodeBxgyCreate?.codeDiscountNode)}`,
        isError: false,
      };
    }
    case "create_free_shipping_discount": {
      const freeShippingCodeDiscount: Record<string, unknown> = {
        title: input.title,
        code: input.code,
        startsAt: new Date().toISOString(),
        ...(input.endsAt ? { endsAt: input.endsAt } : {}),
        customerSelection: { all: true },
        destination: { all: true },
      };
      if (input.minimumSubtotal !== undefined && input.minimumSubtotal !== null) {
        freeShippingCodeDiscount.minimumRequirement = {
          subtotal: { greaterThanOrEqualToSubtotal: String(input.minimumSubtotal) },
        };
      }
      const json = await graphqlJson(admin, CREATE_FREE_SHIPPING_DISCOUNT_MUTATION, {
        freeShippingCodeDiscount,
      });
      const userErrors = json.data?.discountCodeFreeShippingCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Discount creation failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Free-shipping discount created: ${JSON.stringify(json.data?.discountCodeFreeShippingCreate?.codeDiscountNode)}`,
        isError: false,
      };
    }
    case "update_discount_code": {
      const basicCodeDiscount: Record<string, unknown> = {};
      if (input.title !== undefined) basicCodeDiscount.title = input.title;
      if (input.code !== undefined) basicCodeDiscount.code = input.code;
      if (input.endsAt !== undefined) basicCodeDiscount.endsAt = input.endsAt;
      if (input.percentage !== undefined) {
        basicCodeDiscount.customerGets = {
          value: { percentage: Number(input.percentage) / 100 },
          items: { all: true },
        };
      }
      const json = await graphqlJson(admin, UPDATE_DISCOUNT_MUTATION, {
        id: input.id,
        basicCodeDiscount,
      });
      const userErrors = json.data?.discountCodeBasicUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Discount update failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Discount updated: ${JSON.stringify(json.data?.discountCodeBasicUpdate?.codeDiscountNode)}`,
        isError: false,
      };
    }
    case "deactivate_discount_code": {
      const json = await graphqlJson(admin, DEACTIVATE_DISCOUNT_MUTATION, { id: input.id });
      const userErrors = json.data?.discountCodeDeactivate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Deactivation failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Discount deactivated: ${JSON.stringify(json.data?.discountCodeDeactivate?.codeDiscountNode)}`,
        isError: false,
      };
    }
    case "delete_discount_code": {
      const json = await graphqlJson(admin, DELETE_DISCOUNT_MUTATION, { id: input.id });
      const userErrors = json.data?.discountCodeDelete?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Delete failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      const deletedId = json.data?.discountCodeDelete?.deletedCodeDiscountId;
      if (!deletedId) {
        return { content: "Delete failed: Shopify did not confirm the deletion.", isError: true };
      }
      return { content: `Discount ${deletedId} permanently deleted.`, isError: false };
    }
    default:
      return null;
  }
}

/**
 * Approval-card data for deactivate_discount_code / delete_discount_code,
 * verified server-side: the discount's code and current status come from the
 * Admin API at proposal time, never from the model, so the merchant sees
 * exactly which discount is being turned off or removed (same reasoning as
 * prepareDeleteProductWrite).
 */
export async function prepareDiscountStatusWrite(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; warning?: string }> {
  const id = String(input.id ?? "");
  const verb = name === "delete_discount_code" ? "Delete" : "Deactivate";
  const json = await graphqlJson(admin, GET_DISCOUNT_QUERY, { id });
  const discount = json.data?.discountNode?.discount;
  if (!discount) {
    return {
      summary: [`${verb} discount ${id}`, "This discount could not be loaded — it may not exist or may already be deleted."],
      warning: "The discount could not be verified. Approving will attempt the action anyway.",
    };
  }
  const code = discount.codes?.nodes?.[0]?.code;
  return {
    summary: [
      `${verb} discount "${discount.title}"`,
      ...(code ? [`Code: ${code}`] : []),
      `ID: ${json.data.discountNode.id}`,
      `Current status: ${discount.status}`,
    ],
    warning:
      name === "delete_discount_code"
        ? "Deleting a discount is permanent and cannot be undone. Customers can no longer use this code."
        : "Deactivating turns the discount off — customers can no longer use this code until it is reactivated.",
  };
}

/** Approval-modal summaries for this domain's writes; null when not ours. */
export function summarizeDiscountsWrite(name: string, input: Record<string, unknown>): string[] | null {
  if (name === "create_discount_code") {
    return [
      `Create discount code "${input.code}"`,
      `${input.percentage}% off all products, all customers`,
      `Title: ${input.title}`,
      input.endsAt ? `Ends: ${input.endsAt}` : "No end date",
    ];
  }
  if (name === "create_bxgy_discount") {
    const pct = input.getsPercentage === undefined ? 100 : Number(input.getsPercentage);
    return [
      `Create Buy-X-Get-Y discount code "${input.code}"`,
      `Buy ${input.buysQuantity} ${input.buysCollectionId ? "from a collection" : "of any product"}, ` +
        `get ${input.getsQuantity} at ${pct}% off${pct === 100 ? " (free)" : ""}`,
      `Title: ${input.title}`,
      input.endsAt ? `Ends: ${input.endsAt}` : "No end date",
    ];
  }
  if (name === "create_free_shipping_discount") {
    return [
      `Create free-shipping discount code "${input.code}"`,
      input.minimumSubtotal !== undefined && input.minimumSubtotal !== null
        ? `Free shipping on orders of ${input.minimumSubtotal}+ (shop currency), all destinations`
        : "Free shipping for all customers, all destinations",
      `Title: ${input.title}`,
      input.endsAt ? `Ends: ${input.endsAt}` : "No end date",
    ];
  }
  if (name === "update_discount_code") {
    const lines = [`Update discount ${input.id}`];
    if (input.title !== undefined) lines.push(`Set title to "${input.title}"`);
    if (input.code !== undefined) lines.push(`Set code to "${input.code}"`);
    if (input.percentage !== undefined) lines.push(`Set discount to ${input.percentage}% off all products`);
    if (input.endsAt !== undefined) lines.push(`Set end date to ${input.endsAt}`);
    if (lines.length === 1) lines.push("No changes specified.");
    return lines;
  }
  return null;
}
