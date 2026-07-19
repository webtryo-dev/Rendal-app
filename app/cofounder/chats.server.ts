import prisma from "../db.server";
import { dbProvider } from "./billing.server";
import type { AssistantMessage, NeutralMessage, ProviderId, UserMessage } from "./types";

// ---------------------------------------------------------------------------
// Chat persistence — chats / chat_messages in Supabase.
//
// chat_messages.role: user | assistant | tool. Assistant rows keep the
// provider-native replay payload + tool calls in the tool_calls JSONB column;
// tool rows keep their call linkage there too.
// ---------------------------------------------------------------------------

const PROVIDER_FROM_DB: Record<string, ProviderId> = {
  anthropic: "claude",
  openai: "gpt",
  google: "gemini",
};

interface AssistantMeta {
  toolCalls: AssistantMessage["toolCalls"];
  raw: unknown;
  modelLabel?: string;
}

interface ToolMeta {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  syntheticId?: boolean;
}

export async function createChat(shopId: string, firstMessage: string) {
  const title = firstMessage.length > 48 ? `${firstMessage.slice(0, 48)}…` : firstMessage;
  return prisma.chats.create({ data: { shop_id: shopId, title } });
}

export async function getShopChat(shopId: string, chatId: string) {
  const chat = await prisma.chats.findUnique({ where: { id: chatId } });
  return chat && chat.shop_id === shopId ? chat : null;
}

export async function listChats(shopId: string) {
  return prisma.chats.findMany({
    where: { shop_id: shopId },
    orderBy: { updated_at: "desc" },
    select: { id: true, title: true, updated_at: true },
  });
}

export async function loadChatMessages(chatId: string): Promise<NeutralMessage[]> {
  const rows = await prisma.chat_messages.findMany({
    where: { chat_id: chatId },
    orderBy: { created_at: "asc" },
  });
  return rows.map((row): NeutralMessage => {
    if (row.role === "user") {
      const meta = (row.tool_calls ?? {}) as unknown as { attachments?: UserMessage["attachments"] };
      return {
        role: "user",
        text: row.content ?? "",
        ...(meta.attachments?.length ? { attachments: meta.attachments } : {}),
      };
    }
    if (row.role === "assistant") {
      const meta = (row.tool_calls ?? {}) as unknown as AssistantMeta;
      return {
        role: "assistant",
        text: row.content ?? "",
        toolCalls: meta.toolCalls ?? [],
        raw: meta.raw ?? undefined,
        modelLabel: meta.modelLabel,
        provider: row.model_provider ? PROVIDER_FROM_DB[row.model_provider] : undefined,
      };
    }
    const meta = (row.tool_calls ?? {}) as unknown as ToolMeta;
    return {
      role: "tool",
      toolCallId: meta.toolCallId ?? "",
      toolName: meta.toolName ?? "",
      content: row.content ?? "",
      isError: meta.isError,
      syntheticId: meta.syntheticId,
    };
  });
}

/**
 * Persist messages and bump the chat's updated_at. Returns the id of the
 * last persisted assistant row (credit-ledger linkage), if any.
 */
export async function persistMessages(
  chatId: string,
  messages: NeutralMessage[],
): Promise<string | null> {
  let lastAssistantId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      await prisma.chat_messages.create({
        data: {
          chat_id: chatId,
          role: "user",
          content: message.text,
          ...(message.attachments?.length
            ? {
                tool_calls: JSON.parse(JSON.stringify({ attachments: message.attachments })),
                image_urls: message.attachments
                  .filter((att) => att.mimeType.startsWith("image/"))
                  .map((att) => `data:${att.mimeType};base64,${att.data}`),
              }
            : {}),
        },
      });
    } else if (message.role === "assistant") {
      const meta: AssistantMeta = {
        toolCalls: message.toolCalls,
        raw: message.raw,
        modelLabel: message.modelLabel,
      };
      const row = await prisma.chat_messages.create({
        data: {
          chat_id: chatId,
          role: "assistant",
          content: message.text,
          model_provider: message.provider ? dbProvider(message.provider) : null,
          model_name: message.modelLabel ?? null,
          tool_calls: JSON.parse(JSON.stringify(meta)),
        },
      });
      lastAssistantId = row.id;
    } else {
      const meta: ToolMeta = {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        syntheticId: message.syntheticId,
      };
      await prisma.chat_messages.create({
        data: {
          chat_id: chatId,
          role: "tool",
          content: message.content,
          tool_calls: JSON.parse(JSON.stringify(meta)),
        },
      });
    }
  }
  await prisma.chats.update({ where: { id: chatId }, data: { updated_at: new Date() } });
  return lastAssistantId;
}
