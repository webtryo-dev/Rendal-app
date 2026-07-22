import {
  friendlyToolError,
  graphqlJson,
  type AdminContext,
  type NeutralToolDef,
  type ToolExecution,
} from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Customers + CSV export (Phase 8). Every field below is Protected Customer
// Data; a shop without Shopify's level-2 approval gets ACCESS_DENIED, which is
// turned into a one-line explanation by friendlyToolError. The CSV content is
// never put in a tool result (it would leak PII into chat history and the
// model's context) — only a reference to the stored, expiring file is.
// generate_customer_csv is NOT dispatched through executeReadTool — the
// orchestrator calls generateCustomerCsv directly so the CSV bytes never
// enter a tool result. Schemas and implementations live together; the barrel
// (tools.server.ts) aggregates and dispatches.
// ---------------------------------------------------------------------------

export const CUSTOMERS_TOOL_DEFS: NeutralToolDef[] = [
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
];

export const CUSTOMERS_WRITE_TOOL_NAMES: string[] = [];

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

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeCustomersReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
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
    default:
      return null;
  }
}
