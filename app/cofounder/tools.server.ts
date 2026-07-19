import type { authenticate } from "../shopify.server";
import { diffLines } from "./diff.server";
import type { DiffLine } from "./types";

export type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// ---------------------------------------------------------------------------
// Provider-neutral tool definitions. Each adapter translates these into its
// provider's wire format. All GraphQL below was validated against the
// 2026-07 Admin schema via shopify.dev.
//
// Write tools NEVER execute inside the chat loop — the orchestrator pauses
// and returns a pending_write for merchant approval (no silent writes, ever).
// ---------------------------------------------------------------------------

export interface NeutralToolDef {
  name: string;
  description: string;
  /** Plain JSON Schema (object type) for the tool input. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const WRITE_TOOL_NAMES = new Set([
  "update_product",
  "set_inventory_quantity",
  "create_discount_code",
  "update_theme_file",
]);

export const TOOL_DEFS: NeutralToolDef[] = [
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
    name: "get_shipping_setup",
    description:
      "Get the store's shipping setup: which countries the store ships to and the delivery profiles with their shipping zones. Call this when the merchant asks about shipping.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_discounts",
    description:
      "List the store's discounts (code and automatic) with title, status, and summary. Call this when the merchant asks about existing discounts or before creating a new one (to avoid duplicate codes).",
    inputSchema: { type: "object", properties: {}, required: [] },
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
  {
    name: "list_themes",
    description:
      "List the store's themes with their ids, names, and roles (MAIN is the live published theme). Call this before reading or editing theme files.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_theme_files",
    description:
      "List the files in a theme (Liquid templates, JSON templates, CSS, JS, sections, snippets). Use this to find the right file before reading it.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "Theme GID from list_themes." },
      },
      required: ["themeId"],
    },
  },
  {
    name: "read_theme_file",
    description:
      "Read the full text content of one theme file. ALWAYS read a file before proposing an edit to it.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "Theme GID from list_themes." },
        filename: { type: "string", description: "File path, e.g. sections/header.liquid or assets/base.css." },
      },
      required: ["themeId", "filename"],
    },
  },
  {
    name: "update_theme_file",
    description:
      "Propose replacing the content of one theme file (or creating a new file). The merchant reviews a line-level before/after diff and must approve before anything is written — including on the live published theme. Read the current file first and pass the COMPLETE new file content, not a fragment.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "Theme GID from list_themes." },
        filename: { type: "string", description: "File path, e.g. sections/header.liquid." },
        content: { type: "string", description: "The complete new file content." },
      },
      required: ["themeId", "filename", "content"],
    },
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

const GET_SHIPPING_SETUP_QUERY = `#graphql
  query cofounderGetShippingSetup {
    shop {
      name
      shipsToCountries
    }
    deliveryProfiles(first: 10) {
      nodes {
        id
        name
        default
        profileLocationGroups {
          locationGroupZones(first: 10) {
            nodes {
              zone {
                id
                name
                countries {
                  name
                }
              }
            }
          }
        }
      }
    }
  }`;

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

const LIST_THEMES_QUERY = `#graphql
  query cofounderListThemes {
    themes(first: 20) {
      nodes {
        id
        name
        role
        updatedAt
      }
    }
  }`;

const LIST_THEME_FILES_QUERY = `#graphql
  query cofounderListThemeFiles($themeId: ID!, $first: Int!) {
    theme(id: $themeId) {
      id
      name
      role
      files(first: $first) {
        nodes {
          filename
          size
          contentType
        }
        pageInfo { hasNextPage }
      }
    }
  }`;

const READ_THEME_FILE_QUERY = `#graphql
  query cofounderReadThemeFile($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      id
      name
      role
      files(filenames: $filenames, first: 1) {
        nodes {
          filename
          contentType
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText {
              content
            }
            ... on OnlineStoreThemeFileBodyUrl {
              url
            }
          }
        }
      }
    }
  }`;

const UPSERT_THEME_FILE_MUTATION = `#graphql
  mutation cofounderUpsertThemeFile($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
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

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export interface ToolExecution {
  content: string;
  isError: boolean;
}

/**
 * Map a failed tool call to a merchant-readable message. Actual customer PII
 * (email/phone/name/address) is gated behind Shopify's "Protected customer
 * data access" manual review in the Partner Dashboard — not addable via
 * scopes in code — so that specific denial gets a one-line explanation
 * instead of a raw access-denied error. Everything else surfaces verbatim.
 */
function friendlyToolError(name: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/protected customer data|not approved to access|customer.*not approved/i.test(raw)) {
    return "Customer contact details require a pending Shopify approval (Protected customer data access), so that information isn't available yet.";
  }
  return `Tool ${name} failed: ${raw}`;
}

async function graphqlJson(
  admin: AdminContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await response.json();
  // Surface top-level GraphQL errors (e.g. ACCESS_DENIED) — they arrive
  // alongside null data, not in userErrors, and must never look like success.
  const errors = (json as { errors?: { message: string }[] }).errors;
  if (errors && errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(" | "));
  }
  return json;
}

export async function executeReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  try {
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
      case "get_shipping_setup": {
        const json = await graphqlJson(admin, GET_SHIPPING_SETUP_QUERY);
        return {
          content: JSON.stringify({
            shop: json.data?.shop ?? null,
            deliveryProfiles: json.data?.deliveryProfiles?.nodes ?? [],
          }),
          isError: false,
        };
      }
      case "list_themes": {
        const json = await graphqlJson(admin, LIST_THEMES_QUERY);
        return { content: JSON.stringify(json.data?.themes?.nodes ?? []), isError: false };
      }
      case "list_theme_files": {
        const json = await graphqlJson(admin, LIST_THEME_FILES_QUERY, {
          themeId: input.themeId,
          first: 250,
        });
        if (!json.data?.theme) {
          return { content: `No theme found with id ${input.themeId}.`, isError: true };
        }
        return { content: JSON.stringify(json.data.theme), isError: false };
      }
      case "read_theme_file": {
        const file = await fetchThemeFile(
          admin,
          input.themeId as string,
          input.filename as string,
        );
        if (file.error) return { content: file.error, isError: true };
        return {
          content: JSON.stringify({
            theme: { id: file.themeId, name: file.themeName, role: file.themeRole },
            filename: input.filename,
            content: file.content,
          }),
          isError: false,
        };
      }
      case "list_discounts": {
        const json = await graphqlJson(admin, LIST_DISCOUNTS_QUERY);
        return { content: JSON.stringify(json.data?.discountNodes?.nodes ?? []), isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: friendlyToolError(name, error), isError: true };
  }
}

/** Executes an approved write. Only ever called after merchant approval. */
export async function executeWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  try {
    switch (name) {
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
      case "update_theme_file": {
        const json = await graphqlJson(admin, UPSERT_THEME_FILE_MUTATION, {
          themeId: input.themeId,
          files: [
            {
              filename: input.filename,
              body: { type: "TEXT", value: input.content },
            },
          ],
        });
        const userErrors = json.data?.themeFilesUpsert?.userErrors ?? [];
        if (userErrors.length > 0) {
          return { content: `Theme file update failed: ${JSON.stringify(userErrors)}`, isError: true };
        }
        return {
          content: `Theme file ${input.filename} updated successfully.`,
          isError: false,
        };
      }
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
      default:
        return { content: `Unknown write tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: friendlyToolError(name, error), isError: true };
  }
}

interface ThemeFileFetch {
  themeId?: string;
  themeName?: string;
  themeRole?: string;
  content?: string;
  /** Set when the file doesn't exist yet (valid for new-file proposals). */
  missing?: boolean;
  error?: string;
}

async function fetchThemeFile(
  admin: AdminContext,
  themeId: string,
  filename: string,
): Promise<ThemeFileFetch> {
  const json = await graphqlJson(admin, READ_THEME_FILE_QUERY, {
    themeId,
    filenames: [filename],
  });
  const theme = json.data?.theme;
  if (!theme) return { error: `No theme found with id ${themeId}.` };
  const node = theme.files?.nodes?.[0];
  const base = { themeId: theme.id, themeName: theme.name, themeRole: theme.role };
  if (!node) return { ...base, missing: true };
  if (node.body?.__typename !== "OnlineStoreThemeFileBodyText") {
    return {
      ...base,
      error: `${filename} is not a text file (${node.contentType ?? node.body?.__typename}) and can't be read or edited here.`,
    };
  }
  return { ...base, content: node.body.content as string };
}

/**
 * Build the approval-modal details for a theme file edit: a real line-level
 * before/after diff plus a prominent warning when the target is the live
 * (published) theme. Code changes never get a bare "approve?".
 */
export async function prepareThemeWrite(
  admin: AdminContext,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; diff: DiffLine[]; warning?: string }> {
  const filename = String(input.filename ?? "");
  const newContent = String(input.content ?? "");
  const file = await fetchThemeFile(admin, String(input.themeId ?? ""), filename);

  if (file.error) {
    return {
      summary: [`Edit ${filename}`, `Warning: could not load the current file — ${file.error}`],
      diff: diffLines("", newContent),
    };
  }

  const themeLabel = `${file.themeName ?? "theme"} (${file.themeRole ?? "unknown role"})`;
  const summary = file.missing
    ? [`Create new file ${filename}`, `Theme: ${themeLabel}`]
    : [`Edit ${filename}`, `Theme: ${themeLabel}`];

  return {
    summary,
    // New files are pure additions — no phantom deleted empty line.
    diff: file.missing
      ? newContent.split(/\r?\n/).map((text) => ({ type: "add" as const, text }))
      : diffLines(file.content ?? "", newContent),
    warning:
      file.themeRole === "MAIN"
        ? "This edits the LIVE published theme — the change is visible to customers immediately."
        : undefined,
  };
}

/** Human-readable summary of a proposed write, shown in the approval modal. */
export function summarizeWrite(name: string, input: Record<string, unknown>): string[] {
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
  if (name === "create_discount_code") {
    return [
      `Create discount code "${input.code}"`,
      `${input.percentage}% off all products, all customers`,
      `Title: ${input.title}`,
      input.endsAt ? `Ends: ${input.endsAt}` : "No end date",
    ];
  }
  return [`${name}: ${JSON.stringify(input)}`];
}
