import prisma from "../db.server";
import { graphqlJson, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Products + inventory tools: read (search/get/inventory levels) and the
// approval-gated writes (create/update/delete product, set inventory,
// create/update/delete variants, create/update product options,
// attach/remove product images).
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
      "Propose an update to a product's title, description, or status. The merchant must approve the change in a confirmation dialog before it is applied. Call this once you know the exact product id. Only include the fields being changed. This does NOT change variants — for a variant's price, compare-at price, SKU, barcode, or weight use update_variant instead.",
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
    name: "create_product_variants",
    description:
      "Propose adding one or more variants to an existing product (e.g. new sizes or colors), each with its option values and initial price/SKU. The merchant must approve before anything is created. Each variant's optionValues must use option names that already exist on the product (see get_product's options) — call create_product_options first if the option itself doesn't exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID of the product to add variants to." },
        variants: {
          type: "array",
          description: "Variants to create.",
          items: {
            type: "object",
            properties: {
              optionValues: {
                type: "array",
                description: "One entry per product option, e.g. [{optionName: \"Size\", name: \"M\"}].",
                items: {
                  type: "object",
                  properties: {
                    optionName: { type: "string", description: "Existing option name on the product, e.g. \"Size\"." },
                    name: { type: "string", description: "The value for that option, e.g. \"M\". New values are created automatically." },
                  },
                  required: ["optionName", "name"],
                },
              },
              price: { type: "string", description: "Initial price, e.g. \"24.99\"." },
              compareAtPrice: { type: "string", description: "Initial compare-at price, e.g. \"29.99\"." },
              sku: { type: "string", description: "Initial SKU." },
              barcode: { type: "string", description: "Initial barcode." },
            },
            required: ["optionValues"],
          },
        },
        productTitle: { type: "string", description: "Product title, for the merchant-facing approval summary." },
      },
      required: ["productId", "variants"],
    },
  },
  {
    name: "update_variant",
    description:
      "Propose updating one variant's price, compare-at price, SKU, barcode, and/or weight. The merchant must approve the change before it is applied. Use this — not update_product — for variant-level changes. Get the variant id and its current price/compare-at price from get_product first and pass them as currentPrice/currentCompareAtPrice so the approval summary shows old → new. Only include the fields being changed.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID the variant belongs to." },
        variantId: { type: "string", description: "ProductVariant GID, e.g. gid://shopify/ProductVariant/123." },
        price: { type: "string", description: "New price, e.g. \"24.99\"." },
        compareAtPrice: { type: "string", description: "New compare-at price, e.g. \"29.99\"." },
        sku: { type: "string", description: "New SKU." },
        barcode: { type: "string", description: "New barcode." },
        weight: { type: "number", description: "New weight value." },
        weightUnit: { type: "string", enum: ["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"], description: "Unit for weight. Defaults to KILOGRAMS." },
        currentPrice: { type: "string", description: "Variant's current price from get_product, for the approval summary." },
        currentCompareAtPrice: { type: "string", description: "Variant's current compare-at price from get_product, for the approval summary." },
        variantTitle: { type: "string", description: "Variant name (e.g. \"S / Blue\"), for the merchant-facing approval summary." },
      },
      required: ["productId", "variantId"],
    },
  },
  {
    name: "delete_variant",
    description:
      "Propose permanently deleting one variant from a product. The merchant sees the variant in a confirmation dialog and must approve before anything is deleted. Get the exact variant id from get_product first.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID the variant belongs to." },
        variantId: { type: "string", description: "ProductVariant GID of the variant to delete." },
        variantTitle: { type: "string", description: "Variant name, for the merchant-facing approval summary." },
        productTitle: { type: "string", description: "Product title, for the merchant-facing approval summary." },
      },
      required: ["productId", "variantId"],
    },
  },
  {
    name: "create_product_options",
    description:
      "Propose adding one or more options (e.g. Size, Color) with their values to an existing product. The merchant must approve first. Existing variants are assigned the option's first value; no new variants are created automatically — use create_product_variants afterwards for the other combinations.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID of the product to add options to." },
        options: {
          type: "array",
          description: "Options to create.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Option name, e.g. \"Color\"." },
              values: { type: "array", items: { type: "string" }, description: "Option values, e.g. [\"Red\", \"Blue\"]." },
            },
            required: ["name", "values"],
          },
        },
        productTitle: { type: "string", description: "Product title, for the merchant-facing approval summary." },
      },
      required: ["productId", "options"],
    },
  },
  {
    name: "update_product_option",
    description:
      "Propose updating an existing product option: rename it, add new values, and/or delete values no variant uses. The merchant must approve first. Get the option id and its value ids from get_product. A value still used by a variant cannot be deleted — delete that variant first with delete_variant.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID the option belongs to." },
        optionId: { type: "string", description: "ProductOption GID from get_product, e.g. gid://shopify/ProductOption/123." },
        name: { type: "string", description: "New name for the option (omit to keep the current name)." },
        valuesToAdd: { type: "array", items: { type: "string" }, description: "New values to add, e.g. [\"XL\"]." },
        valueIdsToDelete: { type: "array", items: { type: "string" }, description: "ProductOptionValue GIDs (from get_product) to delete. Only values not used by any variant can be deleted." },
        optionName: { type: "string", description: "The option's current name, for the merchant-facing approval summary." },
      },
      required: ["productId", "optionId"],
    },
  },
  {
    name: "attach_product_images",
    description:
      "Propose attaching one or more images to a product's media gallery. The merchant must approve before anything is attached. Each image is either a public image URL or the imageId of an image previously created with generate_image.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID to attach the images to." },
        images: {
          type: "array",
          description: "Images to attach. Each entry needs either url or imageId.",
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "Publicly reachable image URL." },
              imageId: { type: "string", description: "The imageId from a prior generate_image call." },
              alt: { type: "string", description: "Alt text describing the image, for accessibility." },
            },
            required: [],
          },
        },
        productTitle: { type: "string", description: "Product title, for the merchant-facing approval summary." },
      },
      required: ["productId", "images"],
    },
  },
  {
    name: "remove_product_image",
    description:
      "Propose removing one image from a product's media gallery. The merchant must approve first. Get the media id from get_product's media list. The image is detached from the product but the file stays in the store's Files (Content > Files), so it can be re-attached later.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product GID the image is attached to." },
        mediaId: { type: "string", description: "Media GID from get_product, e.g. gid://shopify/MediaImage/123." },
        mediaAlt: { type: "string", description: "The image's alt text or a short description, for the merchant-facing approval summary." },
        productTitle: { type: "string", description: "Product title, for the merchant-facing approval summary." },
      },
      required: ["productId", "mediaId"],
    },
  },
];

export const PRODUCTS_WRITE_TOOL_NAMES = [
  "create_product",
  "update_product",
  "delete_product",
  "set_inventory_quantity",
  "create_product_variants",
  "update_variant",
  "delete_variant",
  "create_product_options",
  "update_product_option",
  "attach_product_images",
  "remove_product_image",
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
      options {
        id
        name
        position
        optionValues {
          id
          name
          hasVariants
        }
      }
      media(first: 20) {
        nodes {
          id
          alt
          mediaContentType
          preview { image { url } }
        }
      }
      variants(first: 20) {
        nodes {
          id
          title
          price
          compareAtPrice
          sku
          barcode
          inventoryQuantity
          selectedOptions {
            name
            value
          }
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

const CREATE_VARIANTS_MUTATION = `#graphql
  mutation cofounderCreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants {
        id
        title
        price
        sku
        selectedOptions { name value }
      }
      userErrors { field message }
    }
  }`;

const UPDATE_VARIANTS_MUTATION = `#graphql
  mutation cofounderUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
        price
        compareAtPrice
        sku
        barcode
      }
      userErrors { field message }
    }
  }`;

const DELETE_VARIANTS_MUTATION = `#graphql
  mutation cofounderDeleteVariant($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }`;

const CREATE_OPTIONS_MUTATION = `#graphql
  mutation cofounderCreateProductOptions($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
      product {
        id
        options { id name optionValues { id name } }
      }
      userErrors { field message }
    }
  }`;

// Attach media via productUpdate's media argument — productCreateMedia is
// deprecated in 2026-07 in favor of productUpdate/productSet.
const ATTACH_PRODUCT_MEDIA_MUTATION = `#graphql
  mutation cofounderAttachProductMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productUpdate(product: {id: $productId}, media: $media) {
      product {
        id
        title
        media(first: 20) { nodes { id alt mediaContentType } }
      }
      userErrors { field message }
    }
  }`;

// Detach media via fileUpdate.referencesToRemove — productDeleteMedia is
// deprecated in 2026-07 in favor of fileUpdate. The file stays in Files.
const REMOVE_PRODUCT_IMAGE_MUTATION = `#graphql
  mutation cofounderRemoveProductImage($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id fileStatus }
      userErrors { field message }
    }
  }`;

// Same staged-upload flow as upload_image_to_files (image.tools.server.ts);
// duplicated here because that file keeps its operations module-private.
const STAGED_UPLOADS_CREATE_MUTATION = `#graphql
  mutation cofounderStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }`;

const UPDATE_OPTION_MUTATION = `#graphql
  mutation cofounderUpdateProductOption($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!], $optionValuesToDelete: [ID!], $variantStrategy: ProductOptionUpdateVariantStrategy) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd, optionValuesToDelete: $optionValuesToDelete, variantStrategy: $variantStrategy) {
      product {
        id
        options { id name optionValues { id name hasVariants } }
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

/**
 * Stages a previously generated image (stored base64 in Prisma) for Shopify
 * ingestion and returns the staged resourceUrl to use as a media
 * originalSource. Same staged-upload approach as upload_image_to_files.
 */
async function stageGeneratedImageForMedia(
  admin: AdminContext,
  shopId: string,
  imageId: string,
): Promise<{ resourceUrl?: string; error?: string }> {
  const image = await prisma.generated_images.findFirst({
    where: { id: imageId, shop_id: shopId },
  });
  if (!image) {
    return { error: `Generated image ${imageId} could not be found. Generate it again before attaching.` };
  }
  const ext =
    image.mime_type === "image/jpeg" ? "jpg" : image.mime_type === "image/webp" ? "webp" : "png";
  const filename = `rendal-${image.id.slice(0, 8)}.${ext}`;
  const bytes = Buffer.from(image.data, "base64");

  const staged = await graphqlJson(admin, STAGED_UPLOADS_CREATE_MUTATION, {
    input: [{ filename, mimeType: image.mime_type, resource: "IMAGE", httpMethod: "POST" }],
  });
  const stagedErrors = staged.data?.stagedUploadsCreate?.userErrors ?? [];
  if (stagedErrors.length > 0) {
    return { error: `Image staging failed: ${JSON.stringify(stagedErrors)}` };
  }
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) {
    return { error: "Image staging failed: Shopify did not return an upload target." };
  }

  const params = (target.parameters ?? []) as { name: string; value: string }[];
  const form = new FormData();
  for (const p of params) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: image.mime_type }), filename);
  const uploadRes = await fetch(target.url, { method: "POST", body: form });
  if (!uploadRes.ok) {
    return { error: `Image staging failed: the storage service returned HTTP ${uploadRes.status}.` };
  }
  return { resourceUrl: target.resourceUrl };
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeProductsWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
  shopId: string,
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
    case "create_product_variants": {
      const variantsInput = (Array.isArray(input.variants) ? input.variants : []) as Array<
        Record<string, unknown>
      >;
      const variants = variantsInput.map((v) => {
        const entry: Record<string, unknown> = {
          optionValues: (Array.isArray(v.optionValues) ? v.optionValues : []).map(
            (ov: Record<string, unknown>) => ({ optionName: ov.optionName, name: ov.name }),
          ),
        };
        if (v.price !== undefined) entry.price = String(v.price);
        if (v.compareAtPrice !== undefined) entry.compareAtPrice = String(v.compareAtPrice);
        if (v.barcode !== undefined) entry.barcode = v.barcode;
        if (v.sku !== undefined) entry.inventoryItem = { sku: v.sku };
        return entry;
      });
      const json = await graphqlJson(admin, CREATE_VARIANTS_MUTATION, {
        productId: input.productId,
        variants,
        strategy: "DEFAULT",
      });
      const userErrors = json.data?.productVariantsBulkCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Variant create failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Variants created: ${JSON.stringify(
          json.data?.productVariantsBulkCreate?.productVariants ?? [],
        )}`,
        isError: false,
      };
    }
    case "update_variant": {
      const variant: Record<string, unknown> = { id: input.variantId };
      if (input.price !== undefined) variant.price = String(input.price);
      if (input.compareAtPrice !== undefined) variant.compareAtPrice = String(input.compareAtPrice);
      if (input.barcode !== undefined) variant.barcode = input.barcode;
      const inventoryItem: Record<string, unknown> = {};
      if (input.sku !== undefined) inventoryItem.sku = input.sku;
      if (typeof input.weight === "number") {
        inventoryItem.measurement = {
          weight: { value: input.weight, unit: input.weightUnit ?? "KILOGRAMS" },
        };
      }
      if (Object.keys(inventoryItem).length > 0) variant.inventoryItem = inventoryItem;
      const json = await graphqlJson(admin, UPDATE_VARIANTS_MUTATION, {
        productId: input.productId,
        variants: [variant],
      });
      const userErrors = json.data?.productVariantsBulkUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Variant update failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Variant updated: ${JSON.stringify(
          json.data?.productVariantsBulkUpdate?.productVariants ?? [],
        )}`,
        isError: false,
      };
    }
    case "delete_variant": {
      const json = await graphqlJson(admin, DELETE_VARIANTS_MUTATION, {
        productId: input.productId,
        variantsIds: [input.variantId],
      });
      const userErrors = json.data?.productVariantsBulkDelete?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Variant delete failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return { content: `Variant ${input.variantId} permanently deleted.`, isError: false };
    }
    case "create_product_options": {
      const optionsInput = (Array.isArray(input.options) ? input.options : []) as Array<
        Record<string, unknown>
      >;
      const options = optionsInput.map((o) => ({
        name: o.name,
        values: (Array.isArray(o.values) ? o.values : []).map((name) => ({ name })),
      }));
      const json = await graphqlJson(admin, CREATE_OPTIONS_MUTATION, {
        productId: input.productId,
        options,
        variantStrategy: "LEAVE_AS_IS",
      });
      const userErrors = json.data?.productOptionsCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Option create failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Options created: ${JSON.stringify(
          json.data?.productOptionsCreate?.product?.options ?? [],
        )}`,
        isError: false,
      };
    }
    case "update_product_option": {
      const option: Record<string, unknown> = { id: input.optionId };
      if (input.name !== undefined) option.name = input.name;
      const valuesToAdd = Array.isArray(input.valuesToAdd) ? input.valuesToAdd : [];
      const valueIdsToDelete = Array.isArray(input.valueIdsToDelete) ? input.valueIdsToDelete : [];
      const json = await graphqlJson(admin, UPDATE_OPTION_MUTATION, {
        productId: input.productId,
        option,
        optionValuesToAdd: valuesToAdd.map((name) => ({ name })),
        optionValuesToDelete: valueIdsToDelete,
        variantStrategy: "LEAVE_AS_IS",
      });
      const userErrors = json.data?.productOptionUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Option update failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Option updated: ${JSON.stringify(
          json.data?.productOptionUpdate?.product?.options ?? [],
        )}`,
        isError: false,
      };
    }
    case "attach_product_images": {
      const imagesInput = (Array.isArray(input.images) ? input.images : []) as Array<
        Record<string, unknown>
      >;
      if (imagesInput.length === 0) {
        return { content: "No images were provided to attach.", isError: true };
      }
      const media: Record<string, unknown>[] = [];
      for (const img of imagesInput) {
        let originalSource: string;
        if (typeof img.url === "string" && img.url.trim()) {
          originalSource = img.url.trim();
        } else if (typeof img.imageId === "string" && img.imageId.trim()) {
          const staged = await stageGeneratedImageForMedia(admin, shopId, img.imageId.trim());
          if (staged.error || !staged.resourceUrl) {
            return { content: staged.error ?? "Image staging failed.", isError: true };
          }
          originalSource = staged.resourceUrl;
        } else {
          return {
            content: "Each image needs either a url or an imageId from generate_image.",
            isError: true,
          };
        }
        media.push({
          mediaContentType: "IMAGE",
          originalSource,
          ...(typeof img.alt === "string" && img.alt.trim() ? { alt: img.alt.trim() } : {}),
        });
      }
      const json = await graphqlJson(admin, ATTACH_PRODUCT_MEDIA_MUTATION, {
        productId: input.productId,
        media,
      });
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Image attach failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Images attached. Product media now: ${JSON.stringify(
          json.data?.productUpdate?.product?.media?.nodes ?? [],
        )}`,
        isError: false,
      };
    }
    case "remove_product_image": {
      const json = await graphqlJson(admin, REMOVE_PRODUCT_IMAGE_MUTATION, {
        files: [{ id: input.mediaId, referencesToRemove: [input.productId] }],
      });
      const userErrors = json.data?.fileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Image removal failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Image ${input.mediaId} removed from product ${input.productId}. The file itself remains in Content > Files.`,
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
  if (name === "create_product_variants") {
    const variants = (Array.isArray(input.variants) ? input.variants : []) as Array<
      Record<string, unknown>
    >;
    const lines = [
      `Add ${variants.length} variant${variants.length === 1 ? "" : "s"} to ${
        input.productTitle ? `"${input.productTitle}"` : input.productId
      }`,
    ];
    for (const v of variants) {
      const label =
        (Array.isArray(v.optionValues) ? v.optionValues : [])
          .map((ov: Record<string, unknown>) => ov.name)
          .join(" / ") || "(no option values)";
      const parts: string[] = [];
      if (v.price !== undefined) parts.push(`price ${v.price}`);
      if (v.compareAtPrice !== undefined) parts.push(`compare-at ${v.compareAtPrice}`);
      if (v.sku !== undefined) parts.push(`SKU ${v.sku}`);
      if (v.barcode !== undefined) parts.push(`barcode ${v.barcode}`);
      lines.push(`${label}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`);
    }
    return lines;
  }
  if (name === "update_variant") {
    const lines = [
      `Update variant ${input.variantTitle ? `"${input.variantTitle}"` : input.variantId}`,
    ];
    if (input.price !== undefined) {
      lines.push(
        input.currentPrice !== undefined
          ? `Price: ${input.currentPrice} → ${input.price}`
          : `Set price to ${input.price}`,
      );
    }
    if (input.compareAtPrice !== undefined) {
      lines.push(
        input.currentCompareAtPrice !== undefined && input.currentCompareAtPrice !== null
          ? `Compare-at price: ${input.currentCompareAtPrice} → ${input.compareAtPrice}`
          : `Set compare-at price to ${input.compareAtPrice}`,
      );
    }
    if (input.sku !== undefined) lines.push(`Set SKU to ${input.sku}`);
    if (input.barcode !== undefined) lines.push(`Set barcode to ${input.barcode}`);
    if (input.weight !== undefined) {
      lines.push(`Set weight to ${input.weight} ${input.weightUnit ?? "KILOGRAMS"}`);
    }
    return lines;
  }
  if (name === "delete_variant") {
    return [
      `Delete variant ${input.variantTitle ? `"${input.variantTitle}"` : input.variantId}`,
      ...(input.productTitle ? [`From product: ${input.productTitle}`] : []),
      `Variant ID: ${input.variantId}`,
      "Deleting a variant is permanent and cannot be undone.",
    ];
  }
  if (name === "create_product_options") {
    const options = (Array.isArray(input.options) ? input.options : []) as Array<
      Record<string, unknown>
    >;
    const lines = [
      `Add ${options.length} option${options.length === 1 ? "" : "s"} to ${
        input.productTitle ? `"${input.productTitle}"` : input.productId
      }`,
    ];
    for (const o of options) {
      lines.push(`${o.name}: ${(Array.isArray(o.values) ? o.values : []).join(", ")}`);
    }
    return lines;
  }
  if (name === "update_product_option") {
    const valuesToAdd = Array.isArray(input.valuesToAdd) ? input.valuesToAdd : [];
    const valueIdsToDelete = Array.isArray(input.valueIdsToDelete) ? input.valueIdsToDelete : [];
    const lines = [
      `Update option ${input.optionName ? `"${input.optionName}"` : input.optionId}`,
    ];
    if (input.name !== undefined) lines.push(`Rename to "${input.name}"`);
    if (valuesToAdd.length > 0) lines.push(`Add values: ${valuesToAdd.join(", ")}`);
    if (valueIdsToDelete.length > 0) {
      lines.push(
        `Delete ${valueIdsToDelete.length} value${valueIdsToDelete.length === 1 ? "" : "s"}: ${valueIdsToDelete.join(", ")}`,
      );
    }
    return lines;
  }
  if (name === "attach_product_images") {
    const images = (Array.isArray(input.images) ? input.images : []) as Array<
      Record<string, unknown>
    >;
    const lines = [
      `Add ${images.length} image${images.length === 1 ? "" : "s"} to ${
        input.productTitle ? `"${input.productTitle}"` : input.productId
      }`,
    ];
    for (const img of images) {
      const alt = img.alt ? ` (alt: ${img.alt})` : "";
      if (img.url) lines.push(`From URL: ${img.url}${alt}`);
      else if (img.imageId) lines.push(`Generated image ${img.imageId}${alt}`);
      else lines.push("(missing url or imageId — this entry will fail)");
    }
    return lines;
  }
  if (name === "remove_product_image") {
    return [
      `Remove an image from ${input.productTitle ? `"${input.productTitle}"` : input.productId}`,
      ...(input.mediaAlt ? [`Image: ${input.mediaAlt}`] : []),
      `Media ID: ${input.mediaId}`,
      "The image is detached from this product but stays in your store's Files.",
    ];
  }
  return null;
}
