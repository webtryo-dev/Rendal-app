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
import { getOverageStatus, rolloverBillingPeriod } from "../cofounder/overage.server";
import { isModelAllowed, requiredPlanForModelTier } from "../cofounder/capabilities.server";
import { planConfig } from "../cofounder/pricing.server";
import { mapShopifyPlanToKey } from "../plan-sync.server";
import {
  createChat,
  deleteChat,
  getShopChat,
  listChats,
  loadChatMessages,
  persistMessages,
  renameChat,
} from "../cofounder/chats.server";
import {
  MODEL_CATALOG,
  TOOL_STATUS_LABELS,
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
  // Set by the app root when Shopify's post-approval redirect carried a
  // plan_handle — Chat is the landing page after choosing a plan.
  const changedKey = mapShopifyPlanToKey(new URL(request.url).searchParams.get("plan_changed"));
  const [skills, chats] = await Promise.all([
    prisma.skills.findMany({
      where: { shop_id: shop.id },
      select: { id: true, name: true, trigger: true },
      orderBy: { name: "asc" },
    }),
    listChats(shop.id),
  ]);

  // The model switcher lists only models the shop's plan allows (a UI
  // convenience — the server action is the real gate). Computed here so the
  // client never imports the server-only capability map.
  const allowedModelIds = MODEL_CATALOG.filter((m) => isModelAllowed(shop.plan, m.tier)).map(
    (m) => m.id,
  );

  return {
    catalog: MODEL_CATALOG,
    skills,
    chats,
    plan: shop.plan,
    allowedModelIds,
    planChangedLabel: changedKey ? planConfig(changedKey).label : null,
  };
};

/** ChatTurnResult plus the chat the turn belongs to. */
type ChatActionResult = Omit<ChatTurnResult, "usage" | "status"> & {
  status:
    | ChatTurnResult["status"]
    | "limit_reached"
    | "plan_upgrade_required"
    | "chat_renamed"
    | "chat_deleted";
  chatId: string | null;
  /** Present when status is "limit_reached". */
  limit?: {
    planLabel: string;
    ceilingUsd: number;
    resumesAt: string;
  };
  /** Present when status is "plan_upgrade_required" (model above the plan's tier). */
  upgrade?: {
    modelLabel: string;
    /** Human label of the lowest plan that unlocks the model. */
    requiredPlan: string;
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ChatActionResult> => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json();
  let shop = await ensureShop(session.shop, admin);
  // Rolling 30-day period: advancing the anchor resets the overage total.
  shop = await rolloverBillingPeriod(shop);

  if (body.intent === "load_chat") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };
    return { status: "done", messages: await loadChatMessages(chat.id), chatId: chat.id };
  }

  if (body.intent === "rename_chat") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };
    await renameChat(shop.id, chat.id, String(body.title ?? ""));
    return { status: "chat_renamed", messages: [], chatId: chat.id };
  }

  if (body.intent === "delete_chat") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };
    await deleteChat(shop.id, chat.id);
    return { status: "chat_deleted", messages: [], chatId: chat.id };
  }

  // Billable intents are blocked once the shop has hit its overage ceiling
  // for this billing period (Shopify App Pricing has no native cap — this
  // in-app check is the only thing preventing runaway billing). Non-billable
  // intents (load_chat) stay available.
  if (body.intent === "chat" || body.intent === "resolve_write") {
    const overage = await getOverageStatus(shop);
    if (overage.blocked) {
      return {
        status: "limit_reached",
        messages: [],
        chatId: (body.chatId as string) ?? null,
        limit: {
          planLabel: overage.planLabel,
          ceilingUsd: overage.ceilingUsd,
          resumesAt: overage.resumesAt.toISOString(),
        },
      };
    }

    // Model-tier gate. The client only offers plan-allowed models, but a client
    // can send any modelId, so the server is the real check: if the requested
    // model is above the shop's plan, don't call it — return an upgrade prompt
    // rendered as a banner (same pattern as limit_reached).
    const requestedModel = MODEL_CATALOG.find((m) => m.id === body.modelId);
    if (requestedModel && !isModelAllowed(shop.plan, requestedModel.tier)) {
      return {
        status: "plan_upgrade_required",
        messages: [],
        chatId: (body.chatId as string) ?? null,
        upgrade: {
          modelLabel: requestedModel.label,
          requiredPlan: planConfig(requiredPlanForModelTier(requestedModel.tier)).label,
        },
      };
    }
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

    const result = await runChatTurn(admin, session.shop, shop.id, shop.plan, body.modelId, input);
    const newMessages = result.messages.slice(input.length);
    const lastAssistantId = await persistMessages(chat.id, newMessages);
    await recordUsage(shop, result.usage, lastAssistantId, admin);

    return { ...result, usage: undefined, chatId: chat.id } as unknown as ChatActionResult;
  }

  if (body.intent === "resolve_write") {
    const chat = await getShopChat(shop.id, body.chatId);
    if (!chat) return { status: "error", messages: [], chatId: null, errorMessage: "Chat not found." };

    const history = await loadChatMessages(chat.id);
    const result = await resolveWrite(
      admin,
      session.shop,
      shop.id,
      shop.plan,
      body.modelId,
      history,
      body.pendingWrite as PendingWrite,
      body.approved === true,
    );
    const newMessages = result.messages.slice(history.length);
    const lastAssistantId = await persistMessages(chat.id, newMessages);
    await recordUsage(shop, result.usage, lastAssistantId, admin);

    return { ...result, usage: undefined, chatId: chat.id } as unknown as ChatActionResult;
  }

  return { status: "error", messages: [], chatId: null, errorMessage: "Unknown intent." };
};

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const DIFF_TONES = { add: "success", del: "critical", ctx: "subdued" } as const;

interface DisplayItem {
  key: string;
  kind: "merchant" | "ai" | "status" | "image" | "download";
  text: string;
  badge?: string;
  attachments?: { name: string; mimeType: string }[];
  /** Set for kind "image": a generated_images id to render inline. */
  imageId?: string;
  /** Set for kind "download": a customer CSV export the merchant can download. */
  download?: { exportId: string; filename: string; rowCount: number };
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
    if (message.role === "tool") {
      // A generated image is surfaced as an inline preview; other tool results
      // stay behind the scenes.
      if (message.toolName === "generate_image" && !message.isError) {
        try {
          const parsed = JSON.parse(message.content) as { imageId?: string };
          if (parsed.imageId) {
            items.push({ key: `${mi}-image`, kind: "image", text: "", imageId: parsed.imageId });
          }
        } catch {
          // Malformed tool result — nothing to render.
        }
      } else if (message.toolName === "generate_customer_csv" && !message.isError) {
        try {
          const parsed = JSON.parse(message.content) as {
            exportId?: string;
            filename?: string;
            rowCount?: number;
          };
          if (parsed.exportId && parsed.filename) {
            items.push({
              key: `${mi}-csv`,
              kind: "download",
              text: "",
              download: {
                exportId: parsed.exportId,
                filename: parsed.filename,
                rowCount: parsed.rowCount ?? 0,
              },
            });
          }
        } catch {
          // Malformed tool result — nothing to render.
        }
      }
      return;
    }
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

/**
 * Renders a server-stored generated image. The bytes are served by the
 * /app/images/:id resource route, which requires the embedded session token —
 * so we fetch through the App Bridge-patched fetch and hand the browser an
 * object URL rather than pointing an <img> straight at the (unauthenticated) URL.
 */
function GeneratedImage({ imageId, maxHeight }: { imageId: string; maxHeight: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(`/app/images/${imageId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  if (failed) return <s-text color="subdued">Image preview unavailable.</s-text>;
  if (!url) {
    return <s-spinner size="base" accessibilityLabel="Loading image"></s-spinner>;
  }
  return (
    <img
      src={url}
      alt="Generated artwork"
      style={{ maxWidth: "100%", maxHeight, borderRadius: 8, display: "block" }}
    />
  );
}

/**
 * A download control for a generated customer CSV. Like GeneratedImage, the
 * file is fetched through the App Bridge-authenticated fetch (an <a href> to
 * the resource route would lack the session token); we hand the browser an
 * object URL and trigger a normal file download.
 */
function CsvDownload({
  exportId,
  filename,
  rowCount,
}: {
  exportId: string;
  filename: string;
  rowCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/app/exports/${exportId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text>{filename}</s-text>
        <s-text color="subdued">
          {`${rowCount} customer${rowCount === 1 ? "" : "s"} · available to download for 24 hours`}
        </s-text>
        {failed && (
          <s-text tone="critical">Download failed — the file may have expired. Ask to export again.</s-text>
        )}
        <s-button
          variant="secondary"
          icon="download"
          onClick={download}
          {...(busy ? { loading: true } : {})}
        >
          Download CSV
        </s-button>
      </s-stack>
    </s-box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CoFounderPage() {
  const { catalog, skills, chats, allowedModelIds, planChangedLabel } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ChatActionResult>();
  const shopify = useAppBridge();

  // Models the shop's plan unlocks — the switcher lists only these.
  const allowedModelIdSet = new Set(allowedModelIds);
  const availableModels = catalog.filter((m) => allowedModelIdSet.has(m.id));

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<NeutralMessage[]>([]);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limitInfo, setLimitInfo] = useState<NonNullable<ChatActionResult["limit"]> | null>(null);
  const [upgradeInfo, setUpgradeInfo] = useState<NonNullable<ChatActionResult["upgrade"]> | null>(
    null,
  );
  // Live per-step status of the running turn, polled from the server.
  const [liveStep, setLiveStep] = useState<string | null>(null);
  const [modelId, setModelId] = useState(
    availableModels.find((m) => m.enabled)?.id ?? availableModels[0]?.id ?? "",
  );
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Sidebar row modes: one chat at most is being renamed or pending a
  // delete confirmation at any time.
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState<string | null>(null);
  // Which intent the in-flight fetcher call carries; only "chat" and
  // "resolve_write" run an AI turn worth surfacing as live status.
  const [pendingIntent, setPendingIntent] = useState<
    "chat" | "resolve_write" | "load_chat" | "rename_chat" | "delete_chat" | null
  >(null);

  const inputRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastHandledData = useRef<ChatActionResult | null>(null);

  const isBusy = fetcher.state !== "idle";
  const isAiBusy = isBusy && (pendingIntent === "chat" || pendingIntent === "resolve_write");

  // The recorded intent is consumed once its round-trip finishes.
  useEffect(() => {
    if (fetcher.state === "idle") setPendingIntent(null);
  }, [fetcher.state]);

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

    // Sidebar-only operations: the chats list refreshes via loader
    // revalidation; the open conversation must not be touched. The active
    // chat's cleanup on delete already happened in confirmDelete.
    if (data.status === "chat_renamed" || data.status === "chat_deleted") return;

    if (data.status === "limit_reached" || data.status === "plan_upgrade_required") {
      if (data.status === "limit_reached") setLimitInfo(data.limit ?? null);
      else setUpgradeInfo(data.upgrade ?? null);
      // The blocked message was never sent — remove the optimistic bubble.
      setMessages((prev) =>
        prev.length > 0 && prev[prev.length - 1].role === "user" ? prev.slice(0, -1) : prev,
      );
      return;
    }
    if (data.status === "done" || data.status === "pending_write") {
      setLimitInfo(null);
      setUpgradeInfo(null);
    }

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

  // While an AI turn is in flight, poll the server for its live step and show
  // it where the reply will land. Polling stops the instant the fetcher
  // resolves. Sidebar operations (load/rename/delete) never trigger this.
  useEffect(() => {
    if (!isAiBusy) {
      setLiveStep(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/app/cofounder-step");
        if (!res.ok) return;
        const data = (await res.json()) as { currentStep: string | null };
        if (!cancelled) setLiveStep(data.currentStep);
      } catch {
        // Transient poll failure — keep the last known step, try again next tick.
      }
    };
    poll();
    const timer = setInterval(poll, 750);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAiBusy]);

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
    setPendingIntent("chat");
    submitJson({ intent: "chat", chatId: activeChatId, modelId, text, attachments: outgoing });
    setAttachments([]);
  };

  const resolvePendingWrite = (approved: boolean) => {
    if (!pendingWrite || !activeChatId || isBusy) return;
    shopify.modal.hide(APPROVE_MODAL_ID);
    const write = pendingWrite;
    setPendingWrite(null);
    setPendingIntent("resolve_write");
    submitJson({ intent: "resolve_write", chatId: activeChatId, modelId, pendingWrite: write, approved });
  };

  const openChat = (chatId: string) => {
    if (isBusy || chatId === activeChatId) return;
    setNotice(null);
    setPendingWrite(null);
    setPendingIntent("load_chat");
    submitJson({ intent: "load_chat", chatId });
  };

  const startNewChat = () => {
    if (isBusy) return;
    setActiveChatId(null);
    setMessages([]);
    setPendingWrite(null);
    setNotice(null);
  };

  const startRename = (chatId: string) => {
    if (isBusy) return;
    setConfirmDeleteChatId(null);
    setRenamingChatId(chatId);
  };

  const commitRename = (chatId: string, raw: string) => {
    setRenamingChatId(null);
    const title = raw.trim();
    const current = chats.find((c) => c.id === chatId)?.title ?? "";
    if (!title || title === current) return; // blank keeps the existing title
    setPendingIntent("rename_chat");
    submitJson({ intent: "rename_chat", chatId, title });
  };

  const requestDelete = (chatId: string) => {
    if (isBusy) return;
    setRenamingChatId(null);
    setConfirmDeleteChatId(chatId);
  };

  const confirmDelete = (chatId: string) => {
    if (isBusy) return;
    setConfirmDeleteChatId(null);
    // Deleting the open chat falls back to the no-chat-selected state,
    // exactly like startNewChat.
    if (chatId === activeChatId) {
      setActiveChatId(null);
      setMessages([]);
      setPendingWrite(null);
      setNotice(null);
    }
    setPendingIntent("delete_chat");
    submitJson({ intent: "delete_chat", chatId });
  };

  const displayItems = toDisplayItems(messages);

  return (
    <s-page heading="Rendal">
      <style>{`@keyframes cofounderPulse { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }`}</style>
      {planChangedLabel && (
        <s-banner tone="success" dismissible>
          {`You're now on the ${planChangedLabel} plan.`}
        </s-banner>
      )}
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
              {chats.map((chat) =>
                renamingChatId === chat.id ? (
                  <s-box key={chat.id} padding="small-300" borderRadius="base" background="subdued">
                    <input
                      autoFocus
                      defaultValue={chat.title ?? ""}
                      aria-label="Chat title"
                      onBlur={(e) => commitRename(chat.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenamingChatId(null);
                      }}
                      style={{
                        width: "100%",
                        border: "1px solid rgba(128,128,128,0.5)",
                        borderRadius: 4,
                        padding: "4px 6px",
                        font: "inherit",
                        background: "transparent",
                        color: "inherit",
                      }}
                    />
                  </s-box>
                ) : confirmDeleteChatId === chat.id ? (
                  <s-box key={chat.id} padding="small-300" borderRadius="base" background="subdued">
                    <s-stack direction="block" gap="small-300">
                      <s-text>{`Delete "${chat.title ?? "Untitled chat"}"?`}</s-text>
                      <s-stack direction="inline" gap="small-300">
                        <s-button
                          variant="primary"
                          tone="critical"
                          onClick={() => confirmDelete(chat.id)}
                        >
                          Delete
                        </s-button>
                        <s-button variant="tertiary" onClick={() => setConfirmDeleteChatId(null)}>
                          Cancel
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-box>
                ) : (
                  <div
                    key={chat.id}
                    style={{ display: "flex", alignItems: "center", gap: 2 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <s-clickable
                        padding="small-300"
                        borderRadius="base"
                        background={chat.id === activeChatId ? "subdued" : "transparent"}
                        onClick={() => openChat(chat.id)}
                      >
                        <s-text>{chat.title ?? "Untitled chat"}</s-text>
                      </s-clickable>
                    </div>
                    <s-button
                      variant="tertiary"
                      icon="edit"
                      accessibilityLabel="Rename chat"
                      onClick={() => startRename(chat.id)}
                    ></s-button>
                    <s-button
                      variant="tertiary"
                      icon="delete"
                      accessibilityLabel="Delete chat"
                      onClick={() => requestDelete(chat.id)}
                    ></s-button>
                  </div>
                ),
              )}
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
                  if (item.kind === "image" && item.imageId) {
                    return (
                      <div key={item.key} style={{ display: "flex", justifyContent: "flex-start" }}>
                        <div style={{ maxWidth: "75%" }}>
                          <s-box padding="base" borderWidth="base" borderRadius="base">
                            <GeneratedImage imageId={item.imageId} maxHeight={360} />
                          </s-box>
                        </div>
                      </div>
                    );
                  }
                  if (item.kind === "download" && item.download) {
                    return (
                      <div key={item.key} style={{ display: "flex", justifyContent: "flex-start" }}>
                        <div style={{ maxWidth: "75%" }}>
                          <CsvDownload {...item.download} />
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
                {isAiBusy && (
                  <s-stack direction="inline" gap="small-300" alignItems="center">
                    <s-spinner size="base" accessibilityLabel="Working"></s-spinner>
                    <span style={{ animation: "cofounderPulse 1.4s ease-in-out infinite" }}>
                      <s-text color="subdued">{liveStep ?? "Thinking…"}</s-text>
                    </span>
                  </s-stack>
                )}
              </s-stack>
            </div>

            {limitInfo && (
              <s-banner heading="Usage limit reached" tone="critical">
                <s-paragraph>
                  {`You've used your included credits plus the $${limitInfo.ceilingUsd} extra-usage allowance on the ${limitInfo.planLabel} plan for this billing period. Standard credits resume ${new Date(limitInfo.resumesAt).toLocaleDateString(undefined, { dateStyle: "medium" })}. Upgrading your plan unlocks more headroom right away — your chat history and settings remain fully available.`}
                </s-paragraph>
              </s-banner>
            )}

            {upgradeInfo && (
              <s-banner heading="Upgrade to use this model" tone="info" dismissible>
                <s-paragraph>
                  {`${upgradeInfo.modelLabel} is available on the ${upgradeInfo.requiredPlan} plan and above — upgrade to use it. Pick a model included in your current plan to keep chatting.`}
                </s-paragraph>
              </s-banner>
            )}

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
                  {availableModels.map((model) => (
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
          {pendingWrite?.previewImageId && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <GeneratedImage imageId={pendingWrite.previewImageId} maxHeight={320} />
            </s-box>
          )}
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
