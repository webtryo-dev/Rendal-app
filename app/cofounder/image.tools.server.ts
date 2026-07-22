import OpenAI from "openai";
import prisma from "../db.server";
import type { UsageEntry } from "./types";
import { graphqlJson, type AdminContext, type NeutralToolDef, type ToolExecution } from "./shared.tools.server";

// ---------------------------------------------------------------------------
// Image tools: generation (GPT Image 2 / gpt-image-2 via the OpenAI Images
// API) and the approval-gated upload to Shopify Files. Generation is metered
// through the same credit ledger as chat, using the image-token rates in
// billing.server.ts. It is a read-type tool — it does not touch the store —
// so it runs without approval; uploading the result does not. generate_image
// is NOT dispatched through executeReadTool — the orchestrator calls
// generateImage directly so it can persist the image and meter usage.
// Schemas and implementations live together; the barrel (tools.server.ts)
// aggregates and dispatches.
// ---------------------------------------------------------------------------

export const IMAGE_TOOL_DEFS: NeutralToolDef[] = [
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

export const IMAGE_WRITE_TOOL_NAMES = ["upload_image_to_files"];

// ---------------------------------------------------------------------------
// GraphQL operations (validated 2026-07)
// ---------------------------------------------------------------------------

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

/** Approved-write cases for this domain; returns null when `name` isn't ours. */
export async function executeImageWriteTool(
  admin: AdminContext,
  name: string,
  input: Record<string, unknown>,
  shopId: string,
): Promise<ToolExecution | null> {
  switch (name) {
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
    default:
      return null;
  }
}
