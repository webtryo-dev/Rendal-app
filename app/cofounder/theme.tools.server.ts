import { diffLines } from "./diff.server";
import type { DiffLine } from "./types";
import {
  THEME_EXEMPTION_MESSAGE,
  graphqlJson,
  isThemeExemptionError,
  type AdminContext,
  type NeutralToolDef,
  type ToolExecution,
} from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Theme tools: reads (list themes/files, read file), the approval-gated file
// edit, and the Founder-only publish/unpublish pair. Schemas and
// implementations live together; the barrel (tools.server.ts) aggregates and
// dispatches. All GraphQL validated against the 2026-07 Admin schema.
// ---------------------------------------------------------------------------

export const THEME_TOOL_DEFS: NeutralToolDef[] = [
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
];

export const THEME_WRITE_TOOL_NAMES = ["update_theme_file", "publish_theme", "unpublish_theme"];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

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

/** Read-tool cases for this domain; returns null when `name` isn't ours. */
export async function executeThemeReadTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
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
    default:
      return null;
  }
}

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeThemeWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution | null> {
  switch (name) {
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
    default:
      return null;
  }
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
