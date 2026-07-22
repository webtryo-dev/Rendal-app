import { graphqlJson, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Shipping tools: the setup read plus the approval-gated zone/rate writes.
// Schemas and implementations live together; the barrel (tools.server.ts)
// aggregates and dispatches. All GraphQL validated against the 2026-07
// Admin schema via shopify.dev.
// ---------------------------------------------------------------------------

export const SHIPPING_TOOL_DEFS: NeutralToolDef[] = [
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
    name: "delete_shipping_zone",
    description:
      "Propose deleting an entire shipping zone — and every rate in it — from a delivery profile. The merchant sees a warning and must approve before anything is deleted. Get the profileId and zoneId from get_shipping_setup first, and pass the zone's name and countries so the merchant sees exactly what is being removed.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "DeliveryProfile GID from get_shipping_setup." },
        zoneId: { type: "string", description: "DeliveryZone GID from get_shipping_setup." },
        zoneName: { type: "string", description: "The zone's name, for the merchant-facing approval summary." },
        countries: { type: "string", description: "The countries the zone covers (e.g. \"DE, FR, NL\"), for the merchant-facing approval summary." },
      },
      required: ["profileId", "zoneId"],
    },
  },
  {
    name: "delete_shipping_rate",
    description:
      "Propose removing one shipping rate (method definition) from a zone. The merchant sees a warning and must approve before anything is removed. Get the profileId and methodDefinitionId from get_shipping_setup first.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "DeliveryProfile GID from get_shipping_setup." },
        methodDefinitionId: { type: "string", description: "DeliveryMethodDefinition GID from get_shipping_setup." },
        rateName: { type: "string", description: "The rate's name, for the merchant-facing approval summary." },
        zoneName: { type: "string", description: "The zone the rate belongs to, for the merchant-facing approval summary." },
      },
      required: ["profileId", "methodDefinitionId"],
    },
  },
];

export const SHIPPING_WRITE_TOOL_NAMES = [
  "create_shipping_zone",
  "update_shipping_zone",
  "set_shipping_rate",
  "delete_shipping_zone",
  "delete_shipping_rate",
];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

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

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeShippingReadTool(
  admin: AdminContext,
  name: string,
): Promise<ToolExecution | null> {
  switch (name) {
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
    default:
      return null;
  }
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeShippingWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
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
    case "delete_shipping_zone": {
      const json = await graphqlJson(admin, DELIVERY_PROFILE_UPDATE_MUTATION, {
        id: input.profileId,
        profile: { zonesToDelete: [input.zoneId] },
      });
      const userErrors = json.data?.deliveryProfileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Shipping zone deletion failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Shipping zone ${input.zoneName ? `"${input.zoneName}"` : input.zoneId} deleted, including all its rates.`,
        isError: false,
      };
    }
    case "delete_shipping_rate": {
      const json = await graphqlJson(admin, DELIVERY_PROFILE_UPDATE_MUTATION, {
        id: input.profileId,
        profile: { methodDefinitionsToDelete: [input.methodDefinitionId] },
      });
      const userErrors = json.data?.deliveryProfileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { content: `Shipping rate removal failed: ${JSON.stringify(userErrors)}`, isError: true };
      }
      return {
        content: `Shipping rate ${input.rateName ? `"${input.rateName}"` : input.methodDefinitionId} removed.`,
        isError: false,
      };
    }
    default:
      return null;
  }
}

/** Approval-modal summaries for this domain's writes; null when not ours. */
export function summarizeShippingWrite(name: string, input: Record<string, unknown>): string[] | null {
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
  if (name === "delete_shipping_zone") {
    return [
      `Delete shipping zone ${input.zoneName ? `"${input.zoneName}"` : input.zoneId}`,
      ...(input.countries ? [`Covers: ${input.countries}`] : []),
      `Zone ID: ${input.zoneId}`,
      "This deletes the zone and ALL of its rates — customers in these countries won't be able to check out unless another zone covers them. This is not easily undone.",
    ];
  }
  if (name === "delete_shipping_rate") {
    return [
      `Remove shipping rate ${input.rateName ? `"${input.rateName}"` : input.methodDefinitionId}`,
      ...(input.zoneName ? [`From zone: ${input.zoneName}`] : []),
      `Rate ID: ${input.methodDefinitionId}`,
      "If this is the zone's only rate, customers in that zone won't be able to check out until a new rate is added. This is not easily undone.",
    ];
  }
  return null;
}
