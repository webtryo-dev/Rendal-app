import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type {
  AssistantMessage,
  CatalogModel,
  NeutralMessage,
  NeutralToolCall,
} from "./types";
import { modelLabel } from "./types";
import type { NeutralToolDef } from "./tools.server";

// ---------------------------------------------------------------------------
// Single adapter interface — the chat orchestrator only ever talks to this.
// Wire formats below follow each provider's current function-calling docs
// (fetched 2026-07-13): Anthropic Messages API, OpenAI Responses API,
// Gemini generateContent.
// ---------------------------------------------------------------------------

export interface AdapterRequest {
  model: CatalogModel;
  system: string;
  messages: NeutralMessage[];
  tools: NeutralToolDef[];
}

export interface AdapterResponse {
  refusal: boolean;
  text: string;
  toolCalls: NeutralToolCall[];
  /** Provider-native assistant payload for faithful same-provider replay. */
  raw: unknown;
  /** Display label of the model that actually served the response. */
  servedByLabel: string;
  /** Token usage for this single API call (credit ledger). */
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelAdapter {
  complete(request: AdapterRequest): Promise<AdapterResponse>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — add it to .env (see .env.example).`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Attachments. Images and PDFs map to each provider's native multimodal
// blocks; text-like files (txt/md/csv/json) are decoded and inlined as text,
// which every provider understands.
// ---------------------------------------------------------------------------

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isTextLike(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

function decodeTextAttachment(attachment: { name: string; data: string }): string {
  const text = Buffer.from(attachment.data, "base64").toString("utf8");
  return `[Attached file: ${attachment.name}]\n${text}`;
}

// ---------------------------------------------------------------------------
// Claude — Anthropic Messages API (beta surface for Fable 5 fallbacks)
// ---------------------------------------------------------------------------

/**
 * Strip pre-fallback thinking/tool_use blocks from assistant content that
 * contains a fallback block, per the server-side fallback replay rules.
 */
function sanitizeClaudeContent(content: unknown[]): unknown[] {
  const lastFallback = content.reduce<number>(
    (last, block, i) => ((block as { type: string }).type === "fallback" ? i : last),
    -1,
  );
  if (lastFallback === -1) return content;
  return content.filter((block, i) => {
    if (i >= lastFallback) return true;
    const type = (block as { type: string }).type;
    return type !== "thinking" && type !== "redacted_thinking" && type !== "tool_use";
  });
}

const claudeAdapter: ModelAdapter = {
  async complete({ model, system, messages, tools }) {
    requireEnv("ANTHROPIC_API_KEY");
    const client = new Anthropic();

    const providerMessages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        if (!message.attachments?.length) {
          providerMessages.push({ role: "user", content: message.text });
        } else {
          const content: Anthropic.Beta.BetaContentBlockParam[] = [];
          for (const att of message.attachments) {
            if (IMAGE_MIMES.has(att.mimeType)) {
              content.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: att.mimeType as "image/png",
                  data: att.data,
                },
              });
            } else if (att.mimeType === "application/pdf") {
              content.push({
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: att.data },
              });
            } else if (isTextLike(att.mimeType)) {
              content.push({ type: "text", text: decodeTextAttachment(att) });
            }
          }
          if (message.text) content.push({ type: "text", text: message.text });
          providerMessages.push({ role: "user", content });
        }
      } else if (message.role === "assistant") {
        if (message.provider === "claude" && Array.isArray(message.raw)) {
          providerMessages.push({
            role: "assistant",
            content: sanitizeClaudeContent(message.raw) as Anthropic.Beta.BetaContentBlockParam[],
          });
        } else {
          const content: Anthropic.Beta.BetaContentBlockParam[] = [];
          if (message.text) content.push({ type: "text", text: message.text });
          for (const call of message.toolCalls) {
            content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
          }
          if (content.length > 0) providerMessages.push({ role: "assistant", content });
        }
      } else {
        const block: Anthropic.Beta.BetaToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError ?? false,
        };
        // Tool results for one assistant turn must share a single user message.
        const previous = providerMessages[providerMessages.length - 1];
        if (
          previous?.role === "user" &&
          Array.isArray(previous.content) &&
          previous.content.every((b) => (b as { type: string }).type === "tool_result")
        ) {
          (previous.content as Anthropic.Beta.BetaToolResultBlockParam[]).push(block);
        } else {
          providerMessages.push({ role: "user", content: [block] });
        }
      }
    }

    const isFable = model.id === "claude-fable-5";
    const response = await client.beta.messages.create({
      model: model.id,
      max_tokens: 16000,
      system,
      messages: providerMessages,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      // Fable 5: thinking is always on — the param must be omitted.
      ...(isFable
        ? {
            betas: ["server-side-fallback-2026-06-01"],
            fallbacks: [{ model: "claude-opus-4-8" }],
          }
        : { thinking: { type: "adaptive" } }),
    });

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    if (response.stop_reason === "refusal") {
      return { refusal: true, text: "", toolCalls: [], raw: null, servedByLabel: modelLabel(response.model), usage };
    }

    return {
      refusal: false,
      text: response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim(),
      toolCalls: response.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
      raw: response.content,
      servedByLabel: modelLabel(response.model),
      usage,
    };
  },
};

// ---------------------------------------------------------------------------
// GPT — OpenAI Responses API
// ---------------------------------------------------------------------------

const gptAdapter: ModelAdapter = {
  async complete({ model, system, messages, tools }) {
    const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        if (!message.attachments?.length) {
          input.push({ role: "user", content: message.text });
        } else {
          const content: Record<string, unknown>[] = [];
          for (const att of message.attachments) {
            if (IMAGE_MIMES.has(att.mimeType)) {
              content.push({
                type: "input_image",
                image_url: `data:${att.mimeType};base64,${att.data}`,
              });
            } else if (att.mimeType === "application/pdf") {
              content.push({
                type: "input_file",
                filename: att.name,
                file_data: `data:application/pdf;base64,${att.data}`,
              });
            } else if (isTextLike(att.mimeType)) {
              content.push({ type: "input_text", text: decodeTextAttachment(att) });
            }
          }
          if (message.text) content.push({ type: "input_text", text: message.text });
          input.push({ role: "user", content });
        }
      } else if (message.role === "assistant") {
        if (message.provider === "gpt" && Array.isArray(message.raw)) {
          input.push(...(message.raw as Record<string, unknown>[]));
        } else {
          if (message.text) input.push({ role: "assistant", content: message.text });
          for (const call of message.toolCalls) {
            input.push({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.input),
            });
          }
        }
      } else {
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.isError ? `ERROR: ${message.content}` : message.content,
        });
      }
    }

    const response = await client.responses.create({
      model: model.id,
      instructions: system,
      input: input as never,
      tools: tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as unknown as Record<string, unknown>,
        strict: false,
      })),
    });

    const toolCalls: NeutralToolCall[] = [];
    for (const item of response.output ?? []) {
      if (item.type === "function_call") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(item.arguments);
        } catch {
          parsed = {};
        }
        toolCalls.push({ id: item.call_id, name: item.name, input: parsed });
      }
    }

    return {
      refusal: false,
      text: (response.output_text ?? "").trim(),
      toolCalls,
      raw: response.output,
      servedByLabel: modelLabel(response.model ?? model.id),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Gemini — generateContent
// ---------------------------------------------------------------------------

const geminiAdapter: ModelAdapter = {
  async complete({ model, system, messages, tools }) {
    const client = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });

    const contents: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        if (!message.attachments?.length) {
          contents.push({ role: "user", parts: [{ text: message.text }] });
        } else {
          const parts: Record<string, unknown>[] = [];
          for (const att of message.attachments) {
            if (IMAGE_MIMES.has(att.mimeType) || att.mimeType === "application/pdf") {
              parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
            } else if (isTextLike(att.mimeType)) {
              parts.push({ text: decodeTextAttachment(att) });
            }
          }
          if (message.text) parts.push({ text: message.text });
          contents.push({ role: "user", parts });
        }
      } else if (message.role === "assistant") {
        if (message.provider === "gemini" && message.raw) {
          contents.push(message.raw as Record<string, unknown>);
        } else {
          const parts: Record<string, unknown>[] = [];
          if (message.text) parts.push({ text: message.text });
          for (const call of message.toolCalls) {
            parts.push({
              functionCall: {
                name: call.name,
                args: call.input,
                ...(call.syntheticId ? {} : { id: call.id }),
              },
            });
          }
          if (parts.length > 0) contents.push({ role: "model", parts });
        }
      } else {
        const part = {
          functionResponse: {
            name: message.toolName,
            response: message.isError
              ? { error: message.content }
              : { result: message.content },
            ...(message.syntheticId ? {} : { id: message.toolCallId }),
          },
        };
        // Function responses for one model turn share a single user turn.
        const previous = contents[contents.length - 1];
        if (
          previous?.role === "user" &&
          Array.isArray(previous.parts) &&
          (previous.parts as Record<string, unknown>[]).every((p) => "functionResponse" in p)
        ) {
          (previous.parts as Record<string, unknown>[]).push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
      }
    }

    const response = await client.models.generateContent({
      model: model.id,
      contents: contents as never,
      config: {
        systemInstruction: system,
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema as never,
            })),
          },
        ],
      },
    });

    const toolCalls: NeutralToolCall[] = (response.functionCalls ?? []).map((fc, i) => ({
      id: fc.id ?? `synthetic-${Date.now()}-${i}`,
      name: fc.name ?? "",
      input: (fc.args ?? {}) as Record<string, unknown>,
      ...(fc.id ? {} : { syntheticId: true }),
    }));

    // Read text from parts directly — the .text helper logs a warning when
    // functionCall parts are present.
    const parts = (response.candidates?.[0]?.content?.parts ?? []) as Array<{
      text?: string;
      thought?: boolean;
    }>;
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();

    return {
      refusal: false,
      text,
      toolCalls,
      raw: response.candidates?.[0]?.content ?? null,
      servedByLabel: modelLabel(model.id),
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens:
          (response.usageMetadata?.candidatesTokenCount ?? 0) +
          (response.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  },
};

// ---------------------------------------------------------------------------

export const ADAPTERS: Record<CatalogModel["provider"], ModelAdapter> = {
  claude: claudeAdapter,
  gpt: gptAdapter,
  gemini: geminiAdapter,
};

/** Build the neutral assistant message for a provider response. */
export function toAssistantMessage(
  model: CatalogModel,
  response: AdapterResponse,
): AssistantMessage {
  return {
    role: "assistant",
    text: response.text,
    toolCalls: response.toolCalls,
    provider: model.provider,
    modelLabel: response.servedByLabel,
    raw: response.raw,
  };
}

export function describeAdapterError(error: unknown): string {
  // GoogleGenAI errors carry a JSON body in the message.
  const text = error instanceof Error ? error.message : String(error);
  const geminiMatch = text.match(/"code"\s*:\s*(\d{3}).*?"message"\s*:\s*"([^"]+)"/s);
  if (geminiMatch) {
    return Number(geminiMatch[1]) === 503 || Number(geminiMatch[1]) === 429
      ? "Gemini is temporarily overloaded. Wait a moment and try again."
      : `Gemini request failed (${geminiMatch[1]}): ${geminiMatch[2]}`;
  }
  if (error instanceof Anthropic.AuthenticationError || (error instanceof OpenAI.APIError && error.status === 401)) {
    return "The provider API key was rejected. Check the keys in .env.";
  }
  if (error instanceof Anthropic.RateLimitError || (error instanceof OpenAI.APIError && error.status === 429)) {
    return "The model is rate-limited right now. Wait a moment and try again.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude request failed (${error.status ?? "network"}): ${error.message}`;
  }
  if (error instanceof OpenAI.APIError) {
    return `GPT request failed (${error.status ?? "network"}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
