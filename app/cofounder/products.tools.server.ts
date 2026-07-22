import { graphqlJson, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Products + inventory tools: read (search/get/inventory levels) and the
// approval-gated writes (create/update/delete product, set inventory).
// Schemas and implementations live together; the barrel (tools.server.ts)
// aggregates and dispatches. All GraphQL validated against the 2026-07
// Admin schema via shopify.dev.
// ---------------------------------------------------------------------------

export const PRODUCTS_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: "search_products",
    description:
      "Search the store's products. Call this when the merchant asks about their products, or before updating a product to find its exact id. The query supports Shopify search syntax (e.g. a title fragment, or status:draft).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Omit to list the most recent products." },
      },
      required: [],
    },
  },
  {
    name: "get_product",
    description:
      "Get full details for one product (description, vendor, tags, variants with prices and inventory). Use the GID from search_products.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Product GID, e.g. gid://shopify/Product/123." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_inventory_levels",
    description:
      "Get per-location inventory levels for every variant of a product, including inventory item ids and location ids (needed before setting inventory). Call this when the merchant asks about stock levels or before proposing an inventory change.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID." },
      },
      required: ["productId"],
    },
  },
  {
    name: "create_product",
    description:
      "Propose creating a new product. The merchant must approve before it is created. New products default to DRAFT status unless the merchant explicitly asks for it to go live immediately.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Product title." },
        descriptionHtml: { type: "string", description: "Product description (HTML allowed)." },
        vendor: { type: "string", description: "Vendor/brand name." },
        tags: { type: "string", description: "Comma-separated tags, e.g. \"winter, sale\"." },
        status: { type: "string", enum: ["ACTIVE", "DRAFT"], description: "Initial status. Defaults to DRAFT." },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_product",
    description:
      "Propose permanently deleting a product. The merchant sees the product's title, id, and current status in a confirmation dialog and must approve before anything is deleted. Use search_products or get_product first to confirm you have the right product id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Product GID of the product to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "update_product",
    description:
      "Propose an update to a product's title, description, or status. The merchant must approve the change in a confirmation dialog before it is applied. Call this once you know the exact product id. Only include the fields being changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Product GID of the product to update." },
        title: { type: "string", description: "New product title." },
        descriptionHtml: { type: "string", description: "New product description (HTML allowed)." },
        status: { type: "string", enum: ["ACTIVE", "DRAFT", "ARCHIVED"], description: "New product status." },
      },
      required: ["id"],
    },
  },
  {
    name: "set_inventory_quantity",
    description:
      "Propose setting the available inventory quantity for one variant at one location. The merchant must approve before it is applied. Get inventoryItemId and locationId from get_inventory_levels first.",
    inputSchema: {
      type: "object",
      properties: {
        inventoryItemId: { type: "string", description: "InventoryItem GID from get_inventory_levels." },
        locationId: { type: "string", description: "Location GID from get_inventory_levels." },
        quantity: { type: "integer", description: "New available quantity (absolute, not a delta)." },
        productTitle: { type: "string", description: "Product/variant name, for the merchant-facing approval summary." },
      },
      required: ["inventoryItemId", "locationId", "quantity"],
    },
  },
];

export const PRODUCTS_WRITE_TOOL_NAMES = [
  "create_product",
  "update_product",
  "delete_product",
  "set_inventory_quantity",
];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

const SEARCH_PRODUCTS_QUERY = `#graphql
  query cofounderSearchProducts($query: String, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        status
        totalInventory
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
      }
    }
  }`;

const GET_PRODUCT_QUERY = `#graphql
  query cofounderGetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      descriptionHtml
      vendor
      tags
      totalInventory
      variants(first: 20) {
        nodes {
          id
          title
          price
          sku
          inventoryQuantity
        }
      }
    }
  }`;

const GET_INVENTORY_LEVELS_QUERY = `#graphql
  query cofounderGetInventoryLevels($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 20) {
        nodes {
          id
          title
          sku
          inventoryItem {
            id
            tracked
            inventoryLevels(first: 10) {
              nodes {
                location { id name }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }`;

const CREATE_PRODUCT_MUTATION = `#graphql
  mutation cofounderCreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        handle
        status
      }
      userErrors { field message }
    }
  }`;

const DELETE_PRODUCT_MUTATION = `#graphql
  mutation cofounderDeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`;

const UPDATE_PRODUCT_MUTATION = `#graphql
  mutation cofounderUpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        status
        descriptionHtml
      }
      userErrors { field message }
    }
  }`;

const SET_INVENTORY_MUTATION = `#graphql
  mutation cofounderSetInventoryQuantity($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes { name delta }
      }
      userErrors { field message }
    }
  }`;

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeProductsReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "search_products": {
      const json = await graphqlJson(admin, SEARCH_PRODUCTS_QUERY, {
        query: (input.query as string) ?? null,
        first: 10,
      });
      return { content: JSON.stringify(json.data?.products?.nodes ?? []), isError: false };
    }
    case "get_product": {
      const json = await graphqlJson(admin, GET_PRODUCT_QUERY, { id: input.id });
      if (!json.data?.product) {
        return { content: `No product found with id ${input.id}.`, isError: true };
      }
      return { content: JSON.stringify(json.data.product), isError: false };
    }
    case "get_inventory_levels": {
      const json = await graphqlJson(admin, GET_INVENTORY_LEVELS_QUERY, { id: input.productId });
      if (!json.data?.product) {
        return { content: `No product found with id ${input.productId}.`, isError: true };
      }
      return { content: JSON.stringify(json.data.product), isError: false };
    }
    default:
      return null;
  }
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeProductsWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
    case "create_product": {
      const product: Record<string, unknown> = {
        title: input.title,
        status: input.status ?? "DRAFT",
      };
      if (input.descriptionHtml !== undefined) product.descriptionHtml = input.descriptionHtml;
      if (input.vendor !== undefined) product.vendor = input.vendor;
      if (typeof input.tags === "string" && input.tags.trim()) {
        product.tags = input.tags.split(",").map((tag: string) => tag.trim()).filter(Boolean);
      }
      const json = await graphqlJson(admin, CREATE_PRODUCT_MUTATION, { product });
      const userErrors = json.data?.productCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Create failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Product created: ${JSON.stringify(json.data?.productCreate?.product)}`,
        isError: false,
      };
    }
    case "delete_product": {
      const json = await graphqlJson(admin, DELETE_PRODUCT_MUTATION, {
        input: { id: input.id },
      });
      const userErrors = json.data?.productDelete?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Delete failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      const deletedId = json.data?.productDelete?.deletedProductId;
      if (!deletedId) {
        return { content: "Delete failed: Shopify did not confirm the deletion.", isError: true };
      }
      return { content: `Product ${deletedId} permanently deleted.`, isError: false };
    }
    case "update_product": {
      const product: Record<string, unknown> = { id: input.id };
      if (input.title !== undefined) product.title = input.title;
      if (input.descriptionHtml !== undefined) product.descriptionHtml = input.descriptionHtml;
      if (input.status !== undefined) product.status = input.status;
      const json = await graphqlJson(admin, UPDATE_PRODUCT_MUTATION, { product });
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Update failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Update applied: ${JSON.stringify(json.data?.productUpdate?.product)}`,
        isError: false,
      };
    }
    case "set_inventory_quantity": {
      const json = await graphqlJson(admin, SET_INVENTORY_MUTATION, {
        input: {
          reason: "correction",
          name: "available",
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId: input.inventoryItemId,
              locationId: input.locationId,
              quantity: input.quantity,
            },
          ],
        },
      });
      const userErrors = json.data?.inventorySetQuantities?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Inventory update failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Inventory set to ${input.quantity} (available). Changes: ${JSON.stringify(
          json.data?.inventorySetQuantities?.inventoryAdjustmentGroup?.changes ?? [],
        )}`,
        isError: false,
      };
    }
    default:
      return null;
  }
}

/**
 * Approval-card data for delete_product, verified server-side: the product's
 * title and status come from the Admin API at proposal time, never from the
 * model, so the merchant sees exactly what would be deleted.
 */
export async function prepareDeleteProductWrite(
  admin: AdminContext,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; warning?: string }> {
  const id = String(input.id ?? "");
  const json = await graphqlJson(admin, GET_PRODUCT_QUERY, { id });
  const product = json.data?.product;
  if (!product) {
    return {
      summary: [`Delete product ${id}`, "This product could not be loaded — it may not exist or may already be deleted."],
      warning: "The product could not be verified. Approving will attempt the deletion anyway.",
    };
  }
  return {
    summary: [
      `Delete product "${product.title}"`,
      `ID: ${product.id}`,
      `Current status: ${product.status}`,
    ],
    warning: "Deleting a product is permanent and cannot be undone.",
  };
}

/** Approval-modal summaries for this domain's writes; null when not ours. */
export function summarizeProductsWrite(name: string, input: Record<string, unknown>): string[] | null {
  if (name === "create_product") {
    const lines = [`Create product "${input.title}"`, `Status: ${input.status ?? "DRAFT"}`];
    if (input.vendor) lines.push(`Vendor: ${input.vendor}`);
    if (input.tags) lines.push(`Tags: ${input.tags}`);
    if (input.descriptionHtml) {
      const text = String(input.descriptionHtml);
      lines.push(`Description: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
    }
    return lines;
  }
  if (name === "update_product") {
    const lines = [`Update product ${input.id}`];
    if (input.title !== undefined) lines.push(`Set title to "${input.title}"`);
    if (input.status !== undefined) lines.push(`Set status to ${input.status}`);
    if (input.descriptionHtml !== undefined) {
      const text = String(input.descriptionHtml);
      lines.push(`Set description to: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
    }
    return lines;
  }
  if (name === "set_inventory_quantity") {
    return [
      `Set available inventory to ${input.quantity}`,
      ...(input.productTitle ? [`For: ${input.productTitle}`] : []),
      `Inventory item: ${input.inventoryItemId}`,
      `Location: ${input.locationId}`,
    ];
  }
  return null;
}
