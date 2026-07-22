import OpenAI from "openai";
import type { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { diffLines } from "./diff.server";
import { fetchUrlAsText } from "./webfetch.server";
import type { DiffLine, UsageEntry } from "./types";

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
  "create_product",
  "update_product",
  "delete_product",
  "set_inventory_quantity",
  "create_shipping_zone",
  "update_shipping_zone",
  "set_shipping_rate",
  "create_discount_code",
  "create_bxgy_discount",
  "create_free_shipping_discount",
  "update_discount_code",
  "deactivate_discount_code",
  "delete_discount_code",
  "update_theme_file",
  "upload_image_to_files",
  "publish_theme",
  "unpublish_theme",
  "update_shop_policies",
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
    name: "fetch_url",
    description:
      "Fetch a public web page (https only) and read its text content. Use for research the merchant asks about — competitor pages, suppliers, articles, documentation. Returns readable text, not raw HTML. Cannot access private/internal hosts.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The https:// URL to fetch." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_shipping_setup",
    description:
      "Get the store's shipping setup: which countries the store ships to and the delivery profiles with their shipping zones. Call this when the merchant asks about shipping.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_shipping_zone",
    description:
      "Propose adding a shipping zone to a delivery profile's location group. The merchant must approve before it is created. Call get_shipping_setup first to get the profileId and locationGroupId. Optionally include an initial flat rate.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "DeliveryProfile GID from get_shipping_setup." },
        locationGroupId: { type: "string", description: "DeliveryLocationGroup GID from get_shipping_setup." },
        zoneName: { type: "string", description: "Name for the new zone, e.g. \"Europe\"." },
        countryCodes: { type: "string", description: "Comma-separated ISO country codes (e.g. \"DE, FR, NL\"), or \"rest_of_world\" for a catch-all zone." },
        rateName: { type: "string", description: "Optional name for an initial flat rate, e.g. \"Standard\"." },
        ratePrice: { type: "number", description: "Optional price for the initial rate, in the shop's currency." },
      },
      required: ["profileId", "locationGroupId", "zoneName", "countryCodes"],
    },
  },
  {
    name: "update_shipping_zone",
    description:
      "Propose renaming a shipping zone and/or replacing its country list. The merchant must approve first. Get ids from get_shipping_setup. Note: countryCodes REPLACES the zone's countries entirely, so include every country the zone should cover.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "DeliveryProfile GID." },
        locationGroupId: { type: "string", description: "DeliveryLocationGroup GID." },
        zoneId: { type: "string", description: "DeliveryZone GID from get_shipping_setup." },
        newName: { type: "string", description: "New zone name (omit to keep)." },
        countryCodes: { type: "string", description: "Full replacement list of comma-separated ISO codes, or \"rest_of_world\" (omit to keep current countries)." },
      },
      required: ["profileId", "locationGroupId", "zoneId"],
    },
  },
  {
    name: "set_shipping_rate",
    description:
      "Propose adding a flat shipping rate to a zone, or updating an existing rate's name/price when methodDefinitionId is provided. The merchant must approve first. Get ids and existing rates from get_shipping_setup. Prices are in the shop's currency.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "DeliveryProfile GID." },
        locationGroupId: { type: "string", description: "DeliveryLocationGroup GID." },
        zoneId: { type: "string", description: "DeliveryZone GID." },
        rateName: { type: "string", description: "Rate name shown at checkout, e.g. \"Standard shipping\"." },
        price: { type: "number", description: "Flat price in the shop's currency, e.g. 5.99. Use 0 for free shipping." },
        methodDefinitionId: { type: "string", description: "Existing DeliveryMethodDefinition GID to update; omit to add a new rate." },
      },
      required: ["profileId", "locationGroupId", "zoneId", "rateName", "price"],
    },
  },
  {
    name: "list_discounts",
    description:
      "List the store's discounts (code and automatic) with title, status, and summary. Call this when the merchant asks about existing discounts or before creating a new one (to avoid duplicate codes).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_analytics",
    description:
      "Query the store's aggregated analytics — sales, orders, traffic/sessions, and conversion rate — using ShopifyQL. Read-only; results are aggregates, not raw customer records. Pass one ShopifyQL query string.\n" +
      "Syntax: FROM <dataset> SHOW <metrics> [ GROUP BY <dimensions> ] [ TIMESERIES <hour|day|week|month> ] [ WHERE <filter> ] [ SINCE <start> UNTIL <end> ] [ ORDER BY <field> [ASC|DESC] ] [ LIMIT <n> ].\n" +
      "Datasets: `sales` (metrics: total_sales, gross_sales, net_sales, orders, ordered_item_quantity, average_order_value, returns; dimensions: product_title, sales_channel, billing_region, …) and `sessions` (metrics: sessions, visitors; used for traffic and conversion rate). Dates accept today, yesterday, relative offsets like -7d/-30d/-3m/-1y, or ISO dates (2026-06-01).\n" +
      'Examples: "FROM sales SHOW total_sales, orders TIMESERIES day SINCE -30d UNTIL today" · "FROM sales SHOW total_sales GROUP BY product_title ORDER BY total_sales DESC LIMIT 10 SINCE -90d" · "FROM sessions SHOW sessions TIMESERIES day SINCE -30d".\n' +
      "If the result includes parse errors, read them and correct the query, then call again. Breakdowns that expose individual customer data may require a pending Shopify data-access approval.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'A single ShopifyQL query string, e.g. "FROM sales SHOW total_sales TIMESERIES month SINCE -3m UNTIL today".',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_shop_info",
    description:
      "Read general store settings and info: shop name, contact email, domains, currency, timezone, weight unit, Shopify plan, and the current legal policy text (refund, privacy, shipping, terms of service). Read-only. Call this before proposing a policy change so you can see the existing text.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_shop_policies",
    description:
      "Propose replacing the full text of one of the store's legal policies — refund, privacy, shipping, or terms of service. The merchant reviews a before/after diff and must approve before it is saved. This REPLACES the entire policy body (HTML allowed); it does not append. Read the current text with get_shop_info first, then pass the COMPLETE new policy text.",
    inputSchema: {
      type: "object",
      properties: {
        policyType: {
          type: "string",
          enum: ["refund", "privacy", "shipping", "terms"],
          description: "Which policy to update.",
        },
        body: {
          type: "string",
          description: "The complete new policy text (HTML allowed). Replaces the existing policy entirely.",
        },
      },
      required: ["policyType", "body"],
    },
  },
  {
    name: "list_customers",
    description:
      "List the store's customers, most recent first, one page at a time. Read-only. Returns name, contact details, order count, and lifetime spend. To page, pass the `after` cursor returned as endCursor from the previous call. Optionally filter with Shopify search syntax (e.g. \"country:United States\" or an email fragment). Customer contact details (name, email, phone, address) are Protected Customer Data — if Shopify hasn't approved that access, this returns a short explanation instead of the records.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Shopify customer search query. Omit to list the most recent customers." },
        after: { type: "string", description: "Optional pagination cursor (endCursor from a previous call)." },
      },
      required: [],
    },
  },
  {
    name: "generate_customer_csv",
    description:
      "Export the store's customers to a CSV file and give the merchant a download link in the chat. Read-only from the store's side. Use when the merchant asks to export, download, or get a spreadsheet of their customers. Optionally filter with the same Shopify search syntax as list_customers. The file contains Protected Customer Data — if Shopify hasn't approved that access, this returns a short explanation instead. The generated file is available to download for 24 hours, then it is deleted.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Shopify customer search query to limit which customers are exported. Omit to export all." },
      },
      required: [],
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
    name: "publish_theme",
    description:
      "Propose making a theme the store's LIVE (published) theme. This immediately replaces the current live theme — every customer sees the new theme right away — and the previously live theme becomes unpublished. The merchant sees which theme is live now and which theme this makes live, and must approve. Get theme ids and roles from list_themes. Note: beyond the write_themes scope, Shopify requires a separate one-time API exemption for a third-party app to publish themes; if it hasn't been granted, the merchant is told rather than shown a raw error.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "GID of the theme to make live (from list_themes). Must be a non-live theme." },
      },
      required: ["themeId"],
    },
  },
  {
    name: "unpublish_theme",
    description:
      "Propose taking the current LIVE theme out of the live slot by publishing a different theme in its place. A store always has exactly one live theme, so unpublishing requires naming the replacement theme that becomes live. The merchant sees the current-live and new-live themes and must approve. Get ids and roles from list_themes. Same Shopify exemption caveat as publish_theme applies.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "GID of the theme that is currently live and should be taken down (from list_themes)." },
        replacementThemeId: { type: "string", description: "GID of the theme to publish in its place — this becomes the new live theme." },
      },
      required: ["themeId", "replacementThemeId"],
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
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using GPT Image 2. Use when the merchant asks you to create or design an image — a product mockup, banner, ad creative, logo concept, social post, etc. The generated image is shown to the merchant in the chat. After it is generated, OFFER to upload it to the store's Files with upload_image_to_files — never upload automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "A detailed description of the image to generate." },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1536", "1536x1024"],
          description: "Dimensions: square, portrait, or landscape. Defaults to 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description: "Rendering quality; higher costs more. Defaults to medium.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "upload_image_to_files",
    description:
      "Propose saving a previously generated image to the store's Files (Content > Files) so it can be reused across the store. The merchant sees a preview of the image and must approve before it is saved. Pass the imageId from a prior generate_image result.",
    inputSchema: {
      type: "object",
      properties: {
        imageId: { type: "string", description: "The imageId returned by a prior generate_image call." },
        filename: { type: "string", description: "Optional filename for the stored file, e.g. summer-banner.png." },
        alt: { type: "string", description: "Optional alt text describing the image, for accessibility." },
      },
      required: ["imageId"],
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
      currencyCode
      shipsToCountries
    }
    deliveryProfiles(first: 10) {
      nodes {
        id
        name
        default
        profileLocationGroups {
          locationGroup {
            id
          }
          locationGroupZones(first: 15) {
            nodes {
              zone {
                id
                name
                countries {
                  name
                  code {
                    countryCode
                    restOfWorld
                  }
                }
              }
              methodDefinitions(first: 10) {
                nodes {
                  id
                  name
                  active
                  rateProvider {
                    ... on DeliveryRateDefinition {
                      id
                      price {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

const DELIVERY_PROFILE_UPDATE_MUTATION = `#graphql
  mutation cofounderDeliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name }
      userErrors { field message }
    }
  }`;

const SHOP_CURRENCY_QUERY = `#graphql
  query cofounderShopCurrency {
    shop {
      currencyCode
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

// Shop settings + legal policies (validated 2026-07). shopPolicyUpdate needs
// the write_legal_policies scope; the read below needs no extra scope.
const GET_SHOP_INFO_QUERY = `#graphql
  query cofounderGetShopInfo {
    shop {
      name
      email
      contactEmail
      myshopifyDomain
      primaryDomain { url host }
      currencyCode
      ianaTimezone
      weightUnit
      plan { displayName partnerDevelopment shopifyPlus }
      shopPolicies { type title url body }
    }
  }`;

const GET_SHOP_POLICIES_QUERY = `#graphql
  query cofounderGetShopPolicies {
    shop {
      shopPolicies { type body }
    }
  }`;

const SHOP_POLICY_UPDATE_MUTATION = `#graphql
  mutation cofounderShopPolicyUpdate($shopPolicy: ShopPolicyInput!) {
    shopPolicyUpdate(shopPolicy: $shopPolicy) {
      shopPolicy { id type url }
      userErrors { field message code }
    }
  }`;

// Customers (validated 2026-07 against shopify.dev, API version July26). email
// and phone now live on defaultEmailAddress/defaultPhoneNumber objects. Every
// name/contact/address field here is Protected Customer Data — the whole query
// is denied (ACCESS_DENIED) unless the app has Shopify's level-2 approval.
const LIST_CUSTOMERS_QUERY = `#graphql
  query cofounderListCustomers($first: Int!, $query: String, $after: String) {
    customers(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        displayName
        firstName
        lastName
        numberOfOrders
        amountSpent { amount currencyCode }
        createdAt
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
        defaultAddress {
          address1
          address2
          city
          province
          provinceCode
          country
          countryCodeV2
          zip
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// ShopifyQL over the Admin API (validated 2026-07 against shopify.dev). The
// return type is a flat object — tableData.columns + tableData.rows — not the
// older TableResponse/PolarisVizResponse union. Requires the read_reports scope.
const SHOPIFYQL_QUERY = `#graphql
  query cofounderShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
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

// themePublish makes a theme the live MAIN theme (validated 2026-07). Beyond
// write_themes, Shopify gates this behind a manual per-app exemption; without
// it the call fails and friendlyToolError explains it. There is no separate
// "unpublish" mutation — publishing a replacement demotes the old live theme.
const THEME_PUBLISH_MUTATION = `#graphql
  mutation cofounderThemePublish($id: ID!) {
    themePublish(id: $id) {
      theme { id name role }
      userErrors { field message code }
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

// Two-step staged upload for Shopify Files (validated 2026-07 against
// shopify.dev): stagedUploadsCreate returns a target to POST the bytes to,
// then fileCreate registers the uploaded object as a Files entry.
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

const FILE_CREATE_MUTATION = `#graphql
  mutation cofounderFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        alt
        ... on MediaImage {
          image { width height url }
        }
      }
      userErrors { field message }
    }
  }`;

// ---------------------------------------------------------------------------
// Image generation (GPT Image 2 / gpt-image-2 via the OpenAI Images API).
// Metered through the same credit ledger as chat, using the image-token rates
// in billing.server.ts. This is a read-type tool — it does not touch the
// store — so it runs without approval; uploading the result does not.
// ---------------------------------------------------------------------------

export const IMAGE_MODEL_ID = "gpt-image-2";

const IMAGE_SIZES: Record<string, { width: number; height: number }> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
  "1536x1024": { width: 1536, height: 1024 },
};

export interface ImageGenResult {
  isError: boolean;
  /** Merchant/model-facing message when generation failed. */
  errorContent?: string;
  image?: { base64: string; mimeType: string; prompt: string; width: number; height: number };
  usage?: UsageEntry;
}

/** OpenAI Images usage payload (typed narrowly to avoid SDK-version coupling). */
interface OpenAIImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number };
}

export async function generateImage(input: Record<string, unknown>): Promise<ImageGenResult> {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) {
    return { isError: true, errorContent: "A text prompt is required to generate an image." };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { isError: true, errorContent: "Image generation is unavailable: OPENAI_API_KEY is not set." };
  }

  const size =
    typeof input.size === "string" && IMAGE_SIZES[input.size] ? input.size : "1024x1024";
  const quality = ["low", "medium", "high", "auto"].includes(String(input.quality))
    ? String(input.quality)
    : "medium";

  const client = new OpenAI({ apiKey });
  const response = await client.images.generate({
    model: IMAGE_MODEL_ID,
    prompt,
    // Validated against our own allow-lists above; cast to the SDK's literal
    // unions (the SDK doesn't widen these to string).
    size: size as OpenAI.Images.ImageGenerateParams["size"],
    quality: quality as OpenAI.Images.ImageGenerateParams["quality"],
    output_format: "png",
    n: 1,
  });
  const result = response as unknown as {
    data?: { b64_json?: string }[];
    usage?: OpenAIImageUsage;
  };

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    return { isError: true, errorContent: "The image service did not return an image. Try rephrasing the prompt." };
  }

  const dims = IMAGE_SIZES[size];
  const u = result.usage;
  const usage: UsageEntry = {
    provider: "gpt",
    modelId: IMAGE_MODEL_ID,
    inputTokens: u?.input_tokens_details?.text_tokens ?? 0,
    outputTokens: 0,
    imageInputTokens: u?.input_tokens_details?.image_tokens ?? 0,
    cachedImageInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    imageOutputTokens: u?.output_tokens ?? 0,
  };

  return {
    isError: false,
    image: { base64: b64, mimeType: "image/png", prompt, width: dims.width, height: dims.height },
    usage,
  };
}

// ---------------------------------------------------------------------------
// Customers + CSV export (Phase 8). Every field below is Protected Customer
// Data; a shop without Shopify's level-2 approval gets ACCESS_DENIED, which is
// turned into a one-line explanation by friendlyToolError. The CSV content is
// never put in a tool result (it would leak PII into chat history and the
// model's context) — only a reference to the stored, expiring file is.
// ---------------------------------------------------------------------------

interface RawCustomer {
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  numberOfOrders?: string | null;
  amountSpent?: { amount: string; currencyCode: string } | null;
  createdAt?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  defaultAddress?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
  } | null;
}

interface FlatCustomer {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string;
  numberOfOrders: number;
  amountSpent: string;
  currency: string;
  createdAt: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  country: string;
  zip: string;
}

function flattenCustomer(c: RawCustomer): FlatCustomer {
  const addr = c.defaultAddress ?? {};
  return {
    id: c.id,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    displayName: c.displayName ?? "",
    email: c.defaultEmailAddress?.emailAddress ?? "",
    phone: c.defaultPhoneNumber?.phoneNumber ?? "",
    numberOfOrders: Number(c.numberOfOrders ?? 0),
    amountSpent: c.amountSpent?.amount ?? "",
    currency: c.amountSpent?.currencyCode ?? "",
    createdAt: c.createdAt ?? "",
    address1: addr.address1 ?? "",
    address2: addr.address2 ?? "",
    city: addr.city ?? "",
    province: addr.province ?? "",
    country: addr.country ?? "",
    zip: addr.zip ?? "",
  };
}

const CSV_COLUMNS: { key: keyof FlatCustomer; header: string }[] = [
  { key: "id", header: "ID" },
  { key: "firstName", header: "First name" },
  { key: "lastName", header: "Last name" },
  { key: "displayName", header: "Display name" },
  { key: "email", header: "Email" },
  { key: "phone", header: "Phone" },
  { key: "numberOfOrders", header: "Orders" },
  { key: "amountSpent", header: "Amount spent" },
  { key: "currency", header: "Currency" },
  { key: "createdAt", header: "Created at" },
  { key: "address1", header: "Address 1" },
  { key: "address2", header: "Address 2" },
  { key: "city", header: "City" },
  { key: "province", header: "Province/State" },
  { key: "country", header: "Country" },
  { key: "zip", header: "ZIP/Postal code" },
];

/** RFC 4180 field escaping — quote when the value contains "," CR or LF. */
function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function customersToCsv(customers: FlatCustomer[]): string {
  const header = CSV_COLUMNS.map((col) => col.header).join(",");
  const rows = customers.map((cust) => CSV_COLUMNS.map((col) => csvEscape(cust[col.key])).join(","));
  // Leading BOM (U+FEFF) so Excel reads UTF-8 (accented names) correctly.
  return String.fromCharCode(0xfeff) + [header, ...rows].join("\r\n");
}

const CSV_MAX_CUSTOMERS = 5000;
const CSV_PAGE_SIZE = 250;

export interface CustomerCsvResult {
  isError: boolean;
  errorContent?: string;
  csv?: string;
  rowCount?: number;
  /** True when the export hit the row cap and more customers exist. */
  truncated?: boolean;
}

/**
 * Page through customers server-side and serialize to CSV. Bounded by
 * CSV_MAX_CUSTOMERS so a huge store can't spin forever; when the cap is hit
 * with more remaining, `truncated` is set so the merchant is told rather than
 * silently given a partial file.
 */
export async function generateCustomerCsv(
  admin: AdminContext,
  input: Record<string, unknown>,
): Promise<CustomerCsvResult> {
  try {
    const query = (input.query as string) ?? null;
    const collected: FlatCustomer[] = [];
    let after: string | null = null;
    let truncated = false;

    for (;;) {
      const remaining = CSV_MAX_CUSTOMERS - collected.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const json = await graphqlJson(admin, LIST_CUSTOMERS_QUERY, {
        first: Math.min(CSV_PAGE_SIZE, remaining),
        query,
        after,
      });
      const connection = json.data?.customers;
      const nodes: RawCustomer[] = connection?.nodes ?? [];
      for (const node of nodes) collected.push(flattenCustomer(node));
      const pageInfo = connection?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }

    return {
      isError: false,
      csv: customersToCsv(collected),
      rowCount: collected.length,
      truncated,
    };
  } catch (error) {
    return { isError: true, errorContent: friendlyToolError("generate_customer_csv", error) };
  }
}

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
/**
 * Publishing a theme needs a manual Shopify per-app exemption on top of the
 * write_themes scope — not fixable in code. When themePublish is refused for
 * that reason (thrown ACCESS_DENIED or a userError), the merchant gets this
 * one-liner instead of a raw error, mirroring the Protected Customer Data path.
 */
const THEME_EXEMPTION_MESSAGE =
  "Publishing themes requires a one-time Shopify API exemption for this app, which hasn't been granted yet — so the live theme wasn't changed. You can request it in the Shopify Partner Dashboard.";

function isThemeExemptionError(text: string): boolean {
  return /exemption|access denied|unauthorized|not authorized|not approved|write_themes/i.test(text);
}

/** Shown when shopPolicyUpdate is refused for lack of the write_legal_policies scope. */
const POLICY_SCOPE_MESSAGE =
  "Updating store policies needs the write_legal_policies permission, which hasn't been granted to this app yet. Re-installing the app to accept the updated permissions will enable it.";

function friendlyToolError(name: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if ((name === "publish_theme" || name === "unpublish_theme") && isThemeExemptionError(raw)) {
    return THEME_EXEMPTION_MESSAGE;
  }
  if (
    name === "update_shop_policies" &&
    /write_legal_policies|access denied|unauthorized|not approved/i.test(raw)
  ) {
    return POLICY_SCOPE_MESSAGE;
  }
  // Analytics access is gated by the read_reports scope and, for
  // customer-linked breakdowns, Shopify's Protected Customer Data (level 2)
  // review — neither is fixable in code. Same one-liner treatment as PII below.
  if (
    name === "read_analytics" &&
    /protected customer data|not approved|access denied|unauthorized|read_reports|permission/i.test(raw)
  ) {
    return "Detailed analytics require a pending Shopify data-access approval, so that data isn't available yet.";
  }
  if (/protected customer data|not approved to access|customer.*not approved/i.test(raw)) {
    return "Customer contact details require a pending Shopify approval (Protected customer data access), so that information isn't available yet.";
  }
  return `Tool ${name} failed: ${raw}`;
}

async function graphqlJson(
  admin: AdminContext,
  query: string,
  variables?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      case "fetch_url": {
        return fetchUrlAsText(String(input.url ?? ""));
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
      case "read_analytics": {
        const json = await graphqlJson(admin, SHOPIFYQL_QUERY, {
          query: String(input.query ?? ""),
        });
        const resp = json.data?.shopifyqlQuery;
        if (!resp) {
          return { content: "No analytics response was returned.", isError: true };
        }
        const parseErrors: string[] = resp.parseErrors ?? [];
        if (parseErrors.length > 0) {
          const joined = parseErrors.join(" | ");
          // A permission/PCD failure surfaced as a parse error gets the same
          // one-line explanation as the thrown-error path below.
          if (/protected|not approved|permission|access denied|unauthorized/i.test(joined)) {
            return {
              content:
                "Detailed analytics require a pending Shopify data-access approval, so that data isn't available yet.",
              isError: true,
            };
          }
          return {
            content: `The analytics query couldn't be parsed: ${joined}. Adjust the ShopifyQL and try again.`,
            isError: true,
          };
        }
        const table = resp.tableData;
        if (!table || !table.columns) {
          return { content: "The query ran but returned no data.", isError: false };
        }
        return {
          content: JSON.stringify({ columns: table.columns, rows: table.rows ?? [] }),
          isError: false,
        };
      }
      case "list_customers": {
        const json = await graphqlJson(admin, LIST_CUSTOMERS_QUERY, {
          first: 25,
          query: (input.query as string) ?? null,
          after: (input.after as string) ?? null,
        });
        const connection = json.data?.customers;
        if (!connection) {
          return { content: "No customers were returned.", isError: false };
        }
        return {
          content: JSON.stringify({
            customers: (connection.nodes ?? []).map(flattenCustomer),
            pageInfo: connection.pageInfo,
          }),
          isError: false,
        };
      }
      case "get_shop_info": {
        const json = await graphqlJson(admin, GET_SHOP_INFO_QUERY);
        const shop = json.data?.shop;
        if (!shop) {
          return { content: "Could not read shop info.", isError: true };
        }
        // Policy bodies can be large — cap each so a huge policy can't blow the
        // model's context. The merchant can still open the policy in the admin.
        const policies = (shop.shopPolicies ?? []).map(
          (p: { type: string; title?: string; url?: string; body?: string }) => ({
            type: p.type,
            title: p.title,
            url: p.url,
            body:
              typeof p.body === "string" && p.body.length > 4000
                ? `${p.body.slice(0, 4000)}… (truncated — ${p.body.length} chars total)`
                : p.body,
          }),
        );
        return { content: JSON.stringify({ ...shop, shopPolicies: policies }), isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: friendlyToolError(name, error), isError: true };
  }
}

/** Executes an approved write. Only ever called after merchant approval. */
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

/** "DE, FR" -> [{code, includeAllProvinces}]; "rest_of_world" -> catch-all. */
function parseCountryCodes(raw: string): Record<string, unknown>[] {
  if (raw.trim().toLowerCase() === "rest_of_world") return [{ restOfWorld: true }];
  return raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
    .map((code) => ({ code, includeAllProvinces: true }));
}

async function shopCurrency(admin: AdminContext): Promise<string> {
  const json = await graphqlJson(admin, SHOP_CURRENCY_QUERY);
  return json.data?.shop?.currencyCode ?? "USD";
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

/**
 * Approval-card data for upload_image_to_files: verifies the generated image
 * still exists for this shop and returns a preview id so the merchant sees the
 * actual image in the approval modal before it is saved to Files.
 */
export async function prepareImageUploadWrite(
  shopId: string,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; warning?: string; previewImageId?: string }> {
  const id = String(input.imageId ?? "");
  const image = await prisma.generated_images.findFirst({
    where: { id, shop_id: shopId },
    select: { id: true, prompt: true, mime_type: true, width: true, height: true },
  });
  if (!image) {
    return {
      summary: [
        `Upload image ${id} to Files`,
        "This generated image could not be found — generate it again before uploading.",
      ],
      warning: "The image could not be verified. Approving will likely fail.",
    };
  }
  const filename =
    typeof input.filename === "string" && input.filename.trim() ? input.filename.trim() : undefined;
  return {
    summary: [
      "Save a generated image to your store's Files",
      image.width && image.height ? `Size: ${image.width}×${image.height}` : `Type: ${image.mime_type}`,
      `Prompt: ${image.prompt.length > 160 ? `${image.prompt.slice(0, 160)}…` : image.prompt}`,
      ...(filename ? [`Filename: ${filename}`] : []),
    ],
    previewImageId: image.id,
  };
}

/**
 * Approval-card data for publish_theme / unpublish_theme. Theme names and roles
 * are read from the Admin API at proposal time (never model copy) so the
 * merchant sees exactly which theme is live now and which becomes live — this
 * is a higher-stakes, storefront-wide change, so the card is explicit and
 * carries a prominent warning.
 */
export async function prepareThemePublishWrite(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; warning?: string }> {
  const json = await graphqlJson(admin, LIST_THEMES_QUERY);
  const themes: { id: string; name: string; role: string }[] = json.data?.themes?.nodes ?? [];
  const byId = (id: string) => themes.find((t) => t.id === id);
  const live = themes.find((t) => t.role === "MAIN");
  const goLiveWarning =
    "This changes the LIVE storefront immediately — every customer sees the new theme right away.";

  if (name === "publish_theme") {
    const target = byId(String(input.themeId ?? ""));
    if (!target) {
      return {
        summary: [`Publish theme ${input.themeId}`, "This theme could not be found — check the id with list_themes."],
        warning: "The theme could not be verified. Approving may fail.",
      };
    }
    if (target.role === "MAIN") {
      return {
        summary: [`Publish theme "${target.name}"`, "This theme is already the live theme, so publishing it would change nothing."],
        warning: "This theme is already live — no change needed.",
      };
    }
    return {
      summary: [
        `Make "${target.name}" the LIVE theme`,
        live ? `Currently live: "${live.name}"` : "No live theme detected",
        `Becomes live: "${target.name}" (currently ${target.role.toLowerCase()})`,
        ...(live ? [`"${live.name}" will be unpublished.`] : []),
      ],
      warning: goLiveWarning,
    };
  }

  // unpublish_theme — publish the replacement in place of the current live theme.
  const target = byId(String(input.themeId ?? ""));
  const replacement = byId(String(input.replacementThemeId ?? ""));
  if (!target) {
    return {
      summary: [`Unpublish theme ${input.themeId}`, "This theme could not be found — check the id with list_themes."],
      warning: "The theme could not be verified. Approving may fail.",
    };
  }
  if (target.role !== "MAIN") {
    return {
      summary: [
        `Unpublish theme "${target.name}"`,
        `This theme isn't the live theme (it's currently ${target.role.toLowerCase()}), so it can't be taken out of the live slot.`,
      ],
      warning: "Only the live theme can be unpublished — nothing would change.",
    };
  }
  if (!replacement) {
    return {
      summary: [
        `Take "${target.name}" out of the live slot`,
        "No replacement theme was specified. A store must always have one live theme, so a replacement is required.",
      ],
      warning: "A replacement theme is required.",
    };
  }
  if (replacement.id === target.id) {
    return {
      summary: [`Take "${target.name}" out of the live slot`, "The replacement must be a different theme."],
      warning: "The replacement theme must differ from the current live theme.",
    };
  }
  return {
    summary: [
      `Take "${target.name}" out of the live slot`,
      `Currently live: "${target.name}"`,
      `New live theme: "${replacement.name}" (currently ${replacement.role.toLowerCase()})`,
      `"${target.name}" will be unpublished.`,
    ],
    warning: goLiveWarning,
  };
}

// Merchant-facing policy names map to the ShopPolicyType enum expected by
// shopPolicyUpdate. Only the four policies in scope for this app are exposed.
const POLICY_TYPE_MAP: Record<string, string> = {
  refund: "REFUND_POLICY",
  privacy: "PRIVACY_POLICY",
  shipping: "SHIPPING_POLICY",
  terms: "TERMS_OF_SERVICE",
};
const POLICY_LABELS: Record<string, string> = {
  refund: "Refund policy",
  privacy: "Privacy policy",
  shipping: "Shipping policy",
  terms: "Terms of service",
};

/**
 * Approval-card data for update_shop_policies: fetches the current policy text
 * from the Admin API and builds a real before/after diff (same review UX as
 * theme edits), so the merchant sees exactly what changes before a full-text
 * replacement is saved.
 */
export async function prepareShopPolicyWrite(
  admin: AdminContext,
  input: Record<string, unknown>,
): Promise<{ summary: string[]; diff?: DiffLine[]; warning?: string }> {
  const policyKey = String(input.policyType ?? "");
  const type = POLICY_TYPE_MAP[policyKey];
  const label = POLICY_LABELS[policyKey] ?? policyKey;
  const newBody = String(input.body ?? "");
  if (!type) {
    return {
      summary: [`Update policy "${policyKey}"`, "Unknown policy type — use refund, privacy, shipping, or terms."],
      warning: "Unknown policy type.",
    };
  }
  const json = await graphqlJson(admin, GET_SHOP_POLICIES_QUERY);
  const policies: { type: string; body?: string }[] = json.data?.shop?.shopPolicies ?? [];
  const current = policies.find((p) => p.type === type);
  const currentBody = current?.body ?? "";
  return {
    summary: [
      `Update the ${label}`,
      "This replaces the entire policy text.",
      ...(current ? [] : ["No existing text for this policy — it will be created."]),
    ],
    diff: currentBody
      ? diffLines(currentBody, newBody)
      : newBody.split(/\r?\n/).map((text) => ({ type: "add" as const, text })),
  };
}

export async function executeWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
  shopId: string,
): Promise<ToolExecution> {
  try {
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
      case "create_shipping_zone": {
        const zone: Record<string, unknown> = {
          name: input.zoneName,
          countries: parseCountryCodes(String(input.countryCodes ?? "")),
        };
        if (input.rateName && input.ratePrice !== undefined) {
          zone.methodDefinitionsToCreate = [
            {
              name: input.rateName,
              active: true,
              rateDefinition: {
                price: { amount: input.ratePrice, currencyCode: await shopCurrency(admin) },
              },
            },
          ];
        }
        const json = await graphqlJson(admin, DELIVERY_PROFILE_UPDATE_MUTATION, {
          id: input.profileId,
          profile: {
            locationGroupsToUpdate: [{ id: input.locationGroupId, zonesToCreate: [zone] }],
          },
        });
        const userErrors = json.data?.deliveryProfileUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          return { content: `Shipping zone creation failed: ${JSON.stringify(userErrors)}`, isError: true };
        }
        return { content: `Shipping zone "${input.zoneName}" created.`, isError: false };
      }
      case "update_shipping_zone": {
        const zoneUpdate: Record<string, unknown> = { id: input.zoneId };
        if (input.newName !== undefined) zoneUpdate.name = input.newName;
        if (input.countryCodes !== undefined) {
          zoneUpdate.countries = parseCountryCodes(String(input.countryCodes));
        }
        const json = await graphqlJson(admin, DELIVERY_PROFILE_UPDATE_MUTATION, {
          id: input.profileId,
          profile: {
            locationGroupsToUpdate: [{ id: input.locationGroupId, zonesToUpdate: [zoneUpdate] }],
          },
        });
        const userErrors = json.data?.deliveryProfileUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          return { content: `Shipping zone update failed: ${JSON.stringify(userErrors)}`, isError: true };
        }
        return { content: `Shipping zone updated.`, isError: false };
      }
      case "set_shipping_rate": {
        const price = { amount: input.price, currencyCode: await shopCurrency(admin) };
        const zoneUpdate: Record<string, unknown> = { id: input.zoneId };
        if (input.methodDefinitionId) {
          zoneUpdate.methodDefinitionsToUpdate = [
            { id: input.methodDefinitionId, name: input.rateName, rateDefinition: { price } },
          ];
        } else {
          zoneUpdate.methodDefinitionsToCreate = [
            { name: input.rateName, active: true, rateDefinition: { price } },
          ];
        }
        const json = await graphqlJson(admin, DELIVERY_PROFILE_UPDATE_MUTATION, {
          id: input.profileId,
          profile: {
            locationGroupsToUpdate: [{ id: input.locationGroupId, zonesToUpdate: [zoneUpdate] }],
          },
        });
        const userErrors = json.data?.deliveryProfileUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          return { content: `Shipping rate change failed: ${JSON.stringify(userErrors)}`, isError: true };
        }
        return {
          content: `Shipping rate "${input.rateName}" ${input.methodDefinitionId ? "updated" : "added"} at ${price.amount} ${price.currencyCode}.`,
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
      case "publish_theme": {
        const json = await graphqlJson(admin, THEME_PUBLISH_MUTATION, { id: input.themeId });
        const userErrors = json.data?.themePublish?.userErrors ?? [];
        if (userErrors.length > 0) {
          const joined = JSON.stringify(userErrors);
          if (isThemeExemptionError(joined)) {
            return { content: THEME_EXEMPTION_MESSAGE, isError: true };
          }
          return { content: `Publishing the theme failed: ${joined}`, isError: true };
        }
        const theme = json.data?.themePublish?.theme;
        if (!theme) {
          return { content: "Publish failed: Shopify did not confirm the change.", isError: true };
        }
        return { content: `Theme "${theme.name}" is now the live theme.`, isError: false };
      }
      case "unpublish_theme": {
        // No unpublish mutation exists — publishing the replacement takes the
        // current live theme out of the live slot (it becomes unpublished).
        const json = await graphqlJson(admin, THEME_PUBLISH_MUTATION, { id: input.replacementThemeId });
        const userErrors = json.data?.themePublish?.userErrors ?? [];
        if (userErrors.length > 0) {
          const joined = JSON.stringify(userErrors);
          if (isThemeExemptionError(joined)) {
            return { content: THEME_EXEMPTION_MESSAGE, isError: true };
          }
          return { content: `Changing the live theme failed: ${joined}`, isError: true };
        }
        const theme = json.data?.themePublish?.theme;
        if (!theme) {
          return { content: "Unpublish failed: Shopify did not confirm the change.", isError: true };
        }
        return {
          content: `Theme "${theme.name}" is now live; the previously live theme has been unpublished.`,
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
      case "upload_image_to_files": {
        const image = await prisma.generated_images.findFirst({
          where: { id: String(input.imageId ?? ""), shop_id: shopId },
        });
        if (!image) {
          return {
            content: "That generated image could not be found. Generate an image first, then upload it.",
            isError: true,
          };
        }
        const ext =
          image.mime_type === "image/jpeg" ? "jpg" : image.mime_type === "image/webp" ? "webp" : "png";
        const filename =
          typeof input.filename === "string" && input.filename.trim()
            ? input.filename.trim()
            : `rendal-${image.id.slice(0, 8)}.${ext}`;
        const bytes = Buffer.from(image.data, "base64");

        // Step 1 — ask Shopify for a staged upload target.
        const staged = await graphqlJson(admin, STAGED_UPLOADS_CREATE_MUTATION, {
          input: [{ filename, mimeType: image.mime_type, resource: "IMAGE", httpMethod: "POST" }],
        });
        const stagedErrors = staged.data?.stagedUploadsCreate?.userErrors ?? [];
        if (stagedErrors.length > 0) {
          return { content: `Upload failed (staging): ${JSON.stringify(stagedErrors)}`, isError: true };
        }
        const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
        if (!target?.url) {
          return { content: "Upload failed: Shopify did not return a staged upload target.", isError: true };
        }

        // Step 2 — POST the bytes to the staged target (multipart, per Shopify's
        // signed parameters), or PUT the raw body if that's what Shopify asked for.
        const params = (target.parameters ?? []) as { name: string; value: string }[];
        const uploadRes =
          (target.httpMethod ?? "POST") === "PUT"
            ? await fetch(target.url, {
                method: "PUT",
                headers: { "Content-Type": image.mime_type },
                body: bytes,
              })
            : await (async () => {
                const form = new FormData();
                for (const p of params) form.append(p.name, p.value);
                form.append("file", new Blob([bytes], { type: image.mime_type }), filename);
                return fetch(target.url, { method: "POST", body: form });
              })();
        if (!uploadRes.ok) {
          return {
            content: `Upload failed: the storage service returned HTTP ${uploadRes.status}.`,
            isError: true,
          };
        }

        // Step 3 — register the uploaded object as a Files entry.
        const created = await graphqlJson(admin, FILE_CREATE_MUTATION, {
          files: [
            {
              originalSource: target.resourceUrl,
              contentType: "IMAGE",
              filename,
              ...(typeof input.alt === "string" && input.alt.trim() ? { alt: input.alt.trim() } : {}),
            },
          ],
        });
        const fileErrors = created.data?.fileCreate?.userErrors ?? [];
        if (fileErrors.length > 0) {
          return { content: `Upload failed (fileCreate): ${JSON.stringify(fileErrors)}`, isError: true };
        }
        const file = created.data?.fileCreate?.files?.[0];
        return {
          content: `Image saved to Files as "${filename}": ${JSON.stringify(file)}`,
          isError: false,
        };
      }
      case "update_shop_policies": {
        const type = POLICY_TYPE_MAP[String(input.policyType ?? "")];
        if (!type) {
          return {
            content: `Unknown policy type "${input.policyType}". Use refund, privacy, shipping, or terms.`,
            isError: true,
          };
        }
        const json = await graphqlJson(admin, SHOP_POLICY_UPDATE_MUTATION, {
          shopPolicy: { type, body: String(input.body ?? "") },
        });
        const userErrors = json.data?.shopPolicyUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          const joined = JSON.stringify(userErrors);
          if (/write_legal_policies|access denied|unauthorized|not approved/i.test(joined)) {
            return { content: POLICY_SCOPE_MESSAGE, isError: true };
          }
          return { content: `Policy update failed: ${joined}`, isError: true };
        }
        const policy = json.data?.shopPolicyUpdate?.shopPolicy;
        return {
          content: `Policy updated (${policy?.type ?? type}): ${JSON.stringify(policy)}`,
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
  if (name === "create_shipping_zone") {
    const lines = [
      `Create shipping zone "${input.zoneName}"`,
      `Countries: ${input.countryCodes}`,
    ];
    if (input.rateName && input.ratePrice !== undefined) {
      lines.push(`Initial rate: "${input.rateName}" at ${input.ratePrice} (shop currency)`);
    } else {
      lines.push("No shipping rate yet — customers in this zone can't check out until one is added.");
    }
    return lines;
  }
  if (name === "update_shipping_zone") {
    const lines = [`Update shipping zone ${input.zoneId}`];
    if (input.newName !== undefined) lines.push(`Rename to "${input.newName}"`);
    if (input.countryCodes !== undefined) lines.push(`Replace countries with: ${input.countryCodes}`);
    if (lines.length === 1) lines.push("No changes specified.");
    return lines;
  }
  if (name === "set_shipping_rate") {
    return [
      `${input.methodDefinitionId ? "Update" : "Add"} shipping rate "${input.rateName}"`,
      `Price: ${input.price} (shop currency)${Number(input.price) === 0 ? " — free shipping" : ""}`,
      `Zone: ${input.zoneId}`,
    ];
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
  return [`${name}: ${JSON.stringify(input)}`];
}
