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

const TITLE_MAX = 48;

function capTitle(title: string) {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

export async function createChat(shopId: string, firstMessage: string) {
  return prisma.chats.create({ data: { shop_id: shopId, title: capTitle(firstMessage) } });
}

export async function getShopChat(shopId: string, chatId: string) {
  const chat = await prisma.chats.findUnique({ where: { id: chatId } });
  return chat && chat.shop_id === shopId ? chat : null;
}

/**
 * Rename a chat. Blank titles keep the existing one; long titles are capped
 * the same way createChat caps derived titles. Returns null when the chat
 * doesn't belong to the shop.
 */
export async function renameChat(shopId: string, chatId: string, title: string) {
  const chat = await getShopChat(shopId, chatId);
  if (!chat) return null;
  const trimmed = title.trim();
  if (!trimmed) return chat;
  return prisma.chats.update({ where: { id: chat.id }, data: { title: capTitle(trimmed) } });
}

/**
 * Delete a chat; chat_messages.chat_id is ON DELETE CASCADE so its messages
 * go with it. Safe for billing history — verified against the live database
 * (pg_constraint): credit_ledger.chat_message_id is ON DELETE SET NULL, so
 * ledger rows survive with the message pointer nulled rather than blocking
 * the delete. Returns false when the chat doesn't belong to the shop.
 */
export async function deleteChat(shopId: string, chatId: string) {
  const chat = await getShopChat(shopId, chatId);
  if (!chat) return false;
  await prisma.chats.delete({ where: { id: chat.id } });
  return true;
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
