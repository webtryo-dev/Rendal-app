import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../shop.server";
import { resolveWrite, runChatTurn } from "../cofounder.server";
import { recordUsage } from "../cofounder/billing.server";
import {
  createChat,
  getShopChat,
  listChats,
  loadChatMessages,
  persistMessages,
} from "../cofounder/chats.server";
import {
  MODEL_CATALOG,
  type Attachment,
  type ChatTurnResult,
  type NeutralMessage,
  type PendingWrite,
} from "../cofounder/types";

const APPROVE_MODAL_ID = "cofounder-approve-write-modal";

// Attachment limits enforced on both sides.
const ATTACHMENT_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf",
  "text/plain", "text/markdown", "text/csv", "application/json",
]);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function sanitizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (att): att is Attachment =>
        typeof att === "object" && att !== null &&
        typeof (att as Attachment).name === "string" &&
        typeof (att as Attachment).mimeType === "string" &&
        typeof (att as Attachment).data === "string" &&
        ATTACHMENT_MIMES.has((att as Attachment).mimeType) &&
        (att as Attachment).data.length <= (MAX_ATTACHMENT_BYTES * 4) / 3 + 4,
    )
    .slice(0, MAX_ATTACHMENTS);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin);
  const [skills, chats] = await Promise.all([
    prisma.skills.findMany({
      where: { shop_id: shop.id },
      select: { id: true, name: true, trigger: true },
      orderBy: { name: "asc" },
    }),
    listChats(shop.id),
  ]);

  return { catalog: MODEL_CATALOG, skills, chats };
};

/** ChatTurnResult plus the chat the turn belongs to. */
type ChatActionResult = Omit<ChatTurnResult, "usage"> & { chatId: string | null };

export const action = async ({ request }: ActionFunctionArgs): Promise<ChatActionResult> => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json();
  const shop = await ensureShop(session.shop, admin);

  if (body.intent === "load_chat") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };
    return { status: "done", messages: await loadChatMessages(chat.id), chatId: chat.id };
  }

  if (body.intent === "chat") {
    const text = String(body.text ?? "").trim();
    const attachments = sanitizeAttachments(body.attachments);
    if (!text && attachments.length === 0) {
      return { status: "error", messages: [], chatId: null, errorMessage: "Empty message." };
    }

    const chat = body.chatId
      ? await getShopChat(shop.id, body.chatId)
      : await createChat(shop.id, text || attachments[0]?.name || "New chat");
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };

    const history = await loadChatMessages(chat.id);
    const userMessage: NeutralMessage = {
      role: "user",
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    await persistMessages(chat.id, [userMessage]);
    const input = [...history, userMessage];

    const result = await runChatTurn(admin, session.shop, body.modelId, input);
    const newMessages = result.messages.slice(input.length);
    const lastAssistantId = await persistMessages(chat.id, newMessages);
    await recordUsage(shop, result.usage, lastAssistantId);

    return { ...result, usage: undefined, chatId: chat.id } as unknown as ChatActionResult;
  }

  if (body.intent === "resolve_write") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };

    const history = await loadChatMessages(chat.id);
    const result = await resolveWrite(
      admin,
      session.shop,
      body.modelId,
      history,
      body.pendingWrite as PendingWrite,
      body.approved === true,
    );
    const newMessages = result.messages.slice(history.length);
    const lastAssistantId = await persistMessages(chat.id, newMessages);
    await recordUsage(shop, result.usage, lastAssistantId);

    return { ...result, usage: undefined, chatId: chat.id } as unknown as ChatActionResult;
  }

  return { status: "error", messages: [], chatId: null, errorMessage: "Unknown intent." };
};

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const TOOL_STATUS_LABELS: Record<string, string> = {
  search_products: "Searching products…",
  get_product: "Reading product details…",
  get_inventory_levels: "Checking inventory levels…",
  get_shipping_setup: "Reading shipping setup…",
  list_discounts: "Reading discounts…",
  list_themes: "Reading themes…",
  list_theme_files: "Listing theme files…",
  read_theme_file: "Reading theme code…",
  update_product: "Proposing a product update…",
  set_inventory_quantity: "Proposing an inventory change…",
  create_discount_code: "Proposing a discount code…",
  update_theme_file: "Proposing a theme code change…",
};

const DIFF_TONES = { add: "success", del: "critical", ctx: "subdued" } as const;

interface DisplayItem {
  key: string;
  kind: "merchant" | "ai" | "status";
  text: string;
  badge?: string;
  attachments?: { name: string; mimeType: string }[];
}

function toDisplayItems(messages: NeutralMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  messages.forEach((message, mi) => {
    if (message.role === "user") {
      items.push({
        key: `${mi}-user`,
        kind: "merchant",
        text: message.text,
        ...(message.attachments?.length
          ? { attachments: message.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })) }
          : {}),
      });
      return;
    }
    if (message.role === "tool") return;
    if (
      Array.isArray(message.raw) &&
      message.raw.some((block) => (block as { type?: string }).type === "fallback")
    ) {
      items.push({
        key: `${mi}-fallback`,
        kind: "status",
        text: "Claude Fable 5 declined — continued on Claude Opus 4.8.",
      });
    }
    if (message.text.trim()) {
      items.push({ key: `${mi}-text`, kind: "ai", text: message.text, badge: message.modelLabel });
    }
    message.toolCalls.forEach((call, ci) => {
      items.push({
        key: `${mi}-tool-${ci}`,
        kind: "status",
        text: TOOL_STATUS_LABELS[call.name] ?? `Running ${call.name}…`,
      });
    });
  });
  return items;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CoFounderPage() {
  const { catalog, skills, chats } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ChatActionResult>();
  const shopify = useAppBridge();

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<NeutralMessage[]>([]);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelId, setModelId] = useState(catalog.find((m) => m.enabled)?.id ?? "");
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const inputRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastHandledData = useRef<ChatActionResult | null>(null);

  const isBusy = fetcher.state !== "idle";

  const submitJson = (payload: Record<string, unknown>) => {
    fetcher.submit(payload as Parameters<typeof fetcher.submit>[0], {
      method: "post",
      encType: "application/json",
    });
  };

  // Apply server results (chat turns, chat loads, write resolutions).
  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== "idle" || data === lastHandledData.current) return;
    lastHandledData.current = data;

    if (data.chatId) setActiveChatId(data.chatId);
    if (data.messages.length > 0 || data.status === "done") setMessages(data.messages);
    setPendingWrite(data.status === "pending_write" ? (data.pendingWrite ?? null) : null);
    setNotice(
      data.status === "refusal" || data.status === "error"
        ? (data.errorMessage ?? "Something went wrong.")
        : null,
    );
    if (data.status === "pending_write") {
      shopify.modal.show(APPROVE_MODAL_ID);
    }
  }, [fetcher.data, fetcher.state, shopify]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, isBusy]);

  const handleComposerInput = () => {
    const value = inputRef.current?.value ?? "";
    const match = value.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    setSkillQuery(match ? match[1].toLowerCase() : null);
  };

  const applySkillSuggestion = (trigger: string) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = el.value.replace(/\/([a-zA-Z0-9_-]*)$/, `/${trigger} `);
    setSkillQuery(null);
    el.focus();
  };

  const skillSuggestions =
    skillQuery === null
      ? []
      : skills.filter((s) => s.trigger.toLowerCase().startsWith(skillQuery)).slice(0, 5);

  const readFileAsBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  // Some browsers report an empty type for .md/.csv/.json — infer from extension.
  const inferMime = (file: File): string => {
    if (file.type) return file.type;
    const ext = file.name.toLowerCase().split(".").pop();
    return ext === "md"
      ? "text/markdown"
      : ext === "csv"
        ? "text/csv"
        : ext === "json"
          ? "application/json"
          : ext === "txt"
            ? "text/plain"
            : "";
  };

  const handleFilesSelected = async (event: { target: HTMLInputElement }) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-selecting the same file
    const accepted: Attachment[] = [];
    for (const file of files) {
      const mimeType = inferMime(file);
      if (!ATTACHMENT_MIMES.has(mimeType)) {
        setNotice(`"${file.name}" isn't a supported file type. Attach images, PDFs, or text files.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setNotice(`"${file.name}" is larger than 5 MB.`);
        continue;
      }
      accepted.push({ name: file.name, mimeType, data: await readFileAsBase64(file) });
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    }
  };

  const removeAttachment = (index: number) =>
    setAttachments((prev) => prev.filter((_, i) => i !== index));

  const sendMessage = () => {
    const text = inputRef.current?.value.trim() ?? "";
    if ((!text && attachments.length === 0) || isBusy || pendingWrite) return;
    if (inputRef.current) inputRef.current.value = "";
    setSkillQuery(null);
    setNotice(null);
    const outgoing = attachments;
    setMessages((prev) => [
      ...prev,
      { role: "user", text, ...(outgoing.length > 0 ? { attachments: outgoing } : {}) },
    ]);
    submitJson({ intent: "chat", chatId: activeChatId, modelId, text, attachments: outgoing });
    setAttachments([]);
  };

  const resolvePendingWrite = (approved: boolean) => {
    if (!pendingWrite || !activeChatId || isBusy) return;
    shopify.modal.hide(APPROVE_MODAL_ID);
    const write = pendingWrite;
    setPendingWrite(null);
    submitJson({ intent: "resolve_write", chatId: activeChatId, modelId, pendingWrite: write, approved });
  };

  const openChat = (chatId: string) => {
    if (isBusy || chatId === activeChatId) return;
    setNotice(null);
    setPendingWrite(null);
    submitJson({ intent: "load_chat", chatId });
  };

  const startNewChat = () => {
    if (isBusy) return;
    setActiveChatId(null);
    setMessages([]);
    setPendingWrite(null);
    setNotice(null);
  };

  const displayItems = toDisplayItems(messages);

  return (
    <s-page heading="Rendal">
      <s-grid gridTemplateColumns="1fr 2.6fr" gap="base">
        {/* Sidebar */}
        <s-section>
          <s-stack direction="block" gap="base">
            <s-button variant="secondary" icon="plus" onClick={startNewChat}>
              New chat
            </s-button>
            <s-divider></s-divider>
            <s-heading>Chat history</s-heading>
            <s-stack direction="block" gap="small-300">
              {chats.length === 0 && (
                <s-text color="subdued">No conversations yet.</s-text>
              )}
              {chats.map((chat) => (
                <s-clickable
                  key={chat.id}
                  padding="small-300"
                  borderRadius="base"
                  background={chat.id === activeChatId ? "subdued" : "transparent"}
                  onClick={() => openChat(chat.id)}
                >
                  <s-text>{chat.title ?? "Untitled chat"}</s-text>
                </s-clickable>
              ))}
            </s-stack>
            <s-divider></s-divider>
            <s-heading>Customize</s-heading>
            <s-stack direction="block" gap="small-300">
              <s-button variant="tertiary" icon="upload" href="/app/skills">
                Upload skill (.md)
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        {/* Chat pane */}
        <s-section>
          <s-stack direction="block" gap="base">
            <div ref={scrollRef} style={{ height: "55vh", overflowY: "auto" }}>
              <s-stack direction="block" gap="base">
                {displayItems.length === 0 && (
                  <s-box padding="base">
                    <s-paragraph color="subdued">
                      Ask Rendal anything about your store — products,
                      inventory, shipping, discounts, marketing. It can read your
                      store data and propose changes, which you approve before
                      anything is applied.
                    </s-paragraph>
                  </s-box>
                )}
                {displayItems.map((item) => {
                  if (item.kind === "merchant") {
                    return (
                      <div key={item.key} style={{ display: "flex", justifyContent: "flex-end" }}>
                        <div style={{ maxWidth: "75%" }}>
                          <s-box padding="base" borderRadius="base" background="subdued">
                            <s-stack direction="block" gap="small-300">
                              {item.attachments?.map((att, ai) => (
                                <s-stack key={ai} direction="inline" gap="small-300" alignItems="center">
                                  <s-icon
                                    type={att.mimeType.startsWith("image/") ? "image" : "attachment"}
                                    size="small"
                                  ></s-icon>
                                  <s-text>{att.name}</s-text>
                                </s-stack>
                              ))}
                              {item.text && <s-text>{item.text}</s-text>}
                            </s-stack>
                          </s-box>
                        </div>
                      </div>
                    );
                  }
                  if (item.kind === "ai") {
                    return (
                      <div key={item.key} style={{ display: "flex", justifyContent: "flex-start" }}>
                        <div style={{ maxWidth: "75%" }}>
                          <s-box padding="base" borderWidth="base" borderRadius="base">
                            <s-stack direction="block" gap="small-300">
                              {item.badge && <s-badge size="base">{item.badge}</s-badge>}
                              <s-text>{item.text}</s-text>
                            </s-stack>
                          </s-box>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <s-stack key={item.key} direction="inline" gap="small-300" alignItems="center">
                      <s-icon type="wrench" size="small" color="subdued"></s-icon>
                      <s-text color="subdued">{item.text}</s-text>
                    </s-stack>
                  );
                })}
                {isBusy && (
                  <s-stack direction="inline" gap="small-300" alignItems="center">
                    <s-spinner size="base" accessibilityLabel="Thinking"></s-spinner>
                    <s-text color="subdued">Thinking…</s-text>
                  </s-stack>
                )}
              </s-stack>
            </div>

            {notice && (
              <s-banner tone="warning" dismissible>
                {notice}
              </s-banner>
            )}

            {pendingWrite && !isBusy && (
              <s-banner heading="Approval needed" tone="info">
                <s-stack direction="block" gap="small-300">
                  <s-text>The assistant proposed a change to your store.</s-text>
                  <s-button variant="secondary" onClick={() => shopify.modal.show(APPROVE_MODAL_ID)}>
                    Review change
                  </s-button>
                </s-stack>
              </s-banner>
            )}

            {/* Composer */}
            <s-stack direction="block" gap="small-300">
              {skillSuggestions.length > 0 && (
                <s-box padding="small-300" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small-300">
                    <s-text color="subdued">Skills</s-text>
                    {skillSuggestions.map((skill) => (
                      <s-clickable
                        key={skill.id}
                        padding="small-300"
                        borderRadius="base"
                        onClick={() => applySkillSuggestion(skill.trigger)}
                      >
                        <s-stack direction="inline" gap="small-300" alignItems="center">
                          <s-badge size="base">/{skill.trigger}</s-badge>
                          <s-text>{skill.name}</s-text>
                        </s-stack>
                      </s-clickable>
                    ))}
                  </s-stack>
                </s-box>
              )}
              {attachments.length > 0 && (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  {attachments.map((att, i) => (
                    <s-box key={i} padding="small-300" borderWidth="base" borderRadius="base">
                      <s-stack direction="inline" gap="small-300" alignItems="center">
                        <s-icon
                          type={att.mimeType.startsWith("image/") ? "image" : "attachment"}
                          size="small"
                        ></s-icon>
                        <s-text>{att.name}</s-text>
                        <s-button
                          variant="tertiary"
                          icon="x"
                          accessibilityLabel={`Remove ${att.name}`}
                          onClick={() => removeAttachment(i)}
                        ></s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              )}
              <s-text-area
                ref={inputRef as never}
                label="Message"
                labelAccessibilityVisibility="exclusive"
                name="message"
                placeholder="Type a message… ( / for skills)"
                rows={2}
                onInput={handleComposerInput}
              ></s-text-area>
              {/* Hidden native input drives the Attach button. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,.md,text/csv,application/json"
                style={{ display: "none" }}
                onChange={(event) => handleFilesSelected(event)}
              />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-select
                  label="Model"
                  labelAccessibilityVisibility="exclusive"
                  name="model"
                  value={modelId}
                  onChange={(event) =>
                    setModelId((event.target as HTMLSelectElement).value)
                  }
                >
                  {catalog.map((model) => (
                    <s-option key={model.id} value={model.id} disabled={!model.enabled}>
                      {`${model.providerLabel} — ${model.label}${model.enabled ? "" : " (soon)"}`}
                    </s-option>
                  ))}
                </s-select>
                <s-button
                  variant="tertiary"
                  icon="attachment"
                  accessibilityLabel="Attach images, PDFs, or text files"
                  {...(attachments.length >= MAX_ATTACHMENTS ? { disabled: true } : {})}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Attach
                </s-button>
                <s-button
                  variant="primary"
                  onClick={sendMessage}
                  {...(isBusy ? { loading: true } : {})}
                >
                  Send
                </s-button>
              </s-stack>
            </s-stack>
          </s-stack>
        </s-section>
      </s-grid>

      {/* Write-approval modal — the only path to executing a gated action. */}
      <s-modal id={APPROVE_MODAL_ID} heading="Approve this change?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Rendal wants to make the following change:
          </s-paragraph>
          {pendingWrite?.warning && (
            <s-banner tone="critical">{pendingWrite.warning}</s-banner>
          )}
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small-300">
              {(pendingWrite?.summary ?? []).map((line, i) => (
                <s-text key={i}>{line}</s-text>
              ))}
            </s-stack>
          </s-box>
          {pendingWrite?.diff && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
                {pendingWrite.diff.map((line, i) => (
                  <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <s-text
                      {...(line.type === "ctx" ? { color: "subdued" as const } : { tone: DIFF_TONES[line.type] as never })}
                    >
                      <code>
                        {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                        {line.text}
                      </code>
                    </s-text>
                  </div>
                ))}
              </div>
            </s-box>
          )}
          <s-paragraph color="subdued">
            Nothing is changed until you approve.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => resolvePendingWrite(true)}
        >
          Approve
        </s-button>
        <s-button slot="secondary-actions" onClick={() => resolvePendingWrite(false)}>
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
