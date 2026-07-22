import {
  graphqlJson,
  type AdminContext,
  type NeutralToolDef,
  type ToolExecution,
} from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Theme tools: READ-ONLY (list themes/files, read file) so Rendal can inspect
// and diagnose theme code. Theme WRITE tools (update_theme_file,
// publish_theme, unpublish_theme) were removed for App Store requirement
// 5.1.1 — apps may not modify merchant themes via the Theme API without an
// approved exemption; theme app extensions can't replace AI file editing.
// If Shopify grants an exemption later, restore the write path from git
// history (it also needs the write_themes scope back in shopify.app.toml).
// All GraphQL validated against the 2026-07 Admin schema.
// ---------------------------------------------------------------------------

export const THEME_TOOL_DEFS: NeutralToolDef[] = [
  {
    name: "list_themes",
    description:
      "List the store's themes with their ids, names, and roles (MAIN is the live published theme). Call this before reading theme files.",
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
      "Read the full text content of one theme file. Read-only — use it to explain or diagnose theme behavior; theme files cannot be modified from here.",
    inputSchema: {
      type: "object",
      properties: {
        themeId: { type: "string", description: "Theme GID from list_themes." },
        filename: { type: "string", description: "File path, e.g. sections/header.liquid or assets/base.css." },
      },
      required: ["themeId", "filename"],
    },
  },
];

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

interface ThemeFileFetch {
  themeId?: string;
  themeName?: string;
  themeRole?: string;
  content?: string;
  /** Set when the file doesn't exist in the theme. */
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
      error: `${filename} is not a text file (${node.contentType ?? node.body?.__typename}) and can't be read here.`,
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
      if (file.missing) {
        return { content: `${input.filename} does not exist in this theme.`, isError: true };
      }
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
