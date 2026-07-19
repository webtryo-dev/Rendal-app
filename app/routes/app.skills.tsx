import { useRef, useState } from "react";
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

const EDIT_MODAL_ID = "skill-edit-modal";
const DELETE_MODAL_ID = "skill-delete-modal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin);
  const rows = await prisma.skills.findMany({
    where: { shop_id: shop.id },
    orderBy: { updated_at: "desc" },
  });
  return {
    skills: rows.map((row) => ({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      instructions: row.instructions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
};

interface ActionResult {
  ok: boolean;
  error?: string;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const body = await request.json();
  const shop = await ensureShop(session.shop);

  try {
    if (body.intent === "create") {
      const { name, trigger, instructions } = normalizeSkillFields(body);
      if (!name || !trigger || !instructions) {
        return { ok: false, error: "The skill needs a name, a trigger, and instructions." };
      }
      await prisma.skills.create({ data: { shop_id: shop.id, name, trigger, instructions } });
      return { ok: true };
    }
    if (body.intent === "update") {
      const { name, trigger, instructions } = normalizeSkillFields(body);
      if (!name || !trigger || !instructions) {
        return { ok: false, error: "The skill needs a name, a trigger, and instructions." };
      }
      const existing = await prisma.skills.findUnique({ where: { id: body.id } });
      if (!existing || existing.shop_id !== shop.id) return { ok: false, error: "Skill not found." };
      await prisma.skills.update({
        where: { id: body.id },
        data: { name, trigger, instructions, updated_at: new Date() },
      });
      return { ok: true };
    }
    if (body.intent === "delete") {
      const existing = await prisma.skills.findUnique({ where: { id: body.id } });
      if (!existing || existing.shop_id !== shop.id) return { ok: false, error: "Skill not found." };
      await prisma.skills.delete({ where: { id: body.id } });
      return { ok: true };
    }
    return { ok: false, error: "Unknown intent." };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { ok: false, error: "A skill with that trigger already exists." };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

function normalizeSkillFields(body: Record<string, unknown>) {
  return {
    name: String(body.name ?? "").trim(),
    trigger: String(body.trigger ?? "")
      .trim()
      .toLowerCase()
      .replace(/^\//, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, ""),
    instructions: String(body.instructions ?? "").trim(),
  };
}

/**
 * Derive name/trigger/instructions from an uploaded .md file. Optional YAML
 * frontmatter (name:/trigger:) wins; otherwise both derive from the filename.
 */
export function parseSkillFile(filename: string, content: string) {
  const base = filename.replace(/\.md$/i, "");
  let name = base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  let trigger = base.toLowerCase();
  let instructions = content.trim();

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatter) {
    instructions = content.slice(frontmatter[0].length).trim();
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (!kv) continue;
      if (kv[1].toLowerCase() === "name") name = kv[2].trim();
      if (kv[1].toLowerCase() === "trigger") trigger = kv[2].trim();
    }
  }
  return { name, trigger, instructions };
}

// ---------------------------------------------------------------------------

type SkillRow = Awaited<ReturnType<typeof loader>>["skills"][number] extends infer T
  ? T & { createdAt: string | Date; updatedAt: string | Date }
  : never;

export default function SkillsPage() {
  const { skills } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();

  const [editing, setEditing] = useState<{ id: string | null }>({ id: null });
  const [deleting, setDeleting] = useState<SkillRow | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const nameRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const triggerRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const instructionsRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const dropZoneRef = useRef<(HTMLElement & { value: string; files?: File[] }) | null>(null);

  const isBusy = fetcher.state !== "idle";
  const notice = uploadError ?? (fetcher.data && !fetcher.data.ok ? fetcher.data.error : null);

  const submitJson = (payload: Record<string, unknown>) => {
    fetcher.submit(payload as Parameters<typeof fetcher.submit>[0], {
      method: "post",
      encType: "application/json",
    });
  };

  const handleUpload = async (event: { currentTarget: { files?: File[]; value?: string } }) => {
    setUploadError(null);
    const files = event.currentTarget.files ?? [];
    const file = files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".md")) {
      setUploadError("Skills must be markdown (.md) files.");
      return;
    }
    const content = await file.text();
    const parsed = parseSkillFile(file.name, content);
    submitJson({ intent: "create", ...parsed });
    if (dropZoneRef.current) dropZoneRef.current.value = "";
  };

  const openEdit = (skill: SkillRow) => {
    setEditing({ id: skill.id });
    // Set imperatively — the fields are uncontrolled custom elements.
    requestAnimationFrame(() => {
      if (nameRef.current) nameRef.current.value = skill.name;
      if (triggerRef.current) triggerRef.current.value = skill.trigger;
      if (instructionsRef.current) instructionsRef.current.value = skill.instructions;
    });
    shopify.modal.show(EDIT_MODAL_ID);
  };

  const saveEdit = () => {
    if (!editing.id) return;
    shopify.modal.hide(EDIT_MODAL_ID);
    submitJson({
      intent: "update",
      id: editing.id,
      name: nameRef.current?.value ?? "",
      trigger: triggerRef.current?.value ?? "",
      instructions: instructionsRef.current?.value ?? "",
    });
  };

  const openDelete = (skill: SkillRow) => {
    setDeleting(skill);
    shopify.modal.show(DELETE_MODAL_ID);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    shopify.modal.hide(DELETE_MODAL_ID);
    submitJson({ intent: "delete", id: deleting.id });
    setDeleting(null);
  };

  const formatDate = (value: string | Date) =>
    new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <s-page heading="Skills">
      <s-section heading="Upload a skill">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Skills are markdown instruction files Rendal can apply on
            demand. Trigger one in chat by typing /its-trigger. Optional
            frontmatter (name: / trigger:) overrides the filename defaults.
          </s-paragraph>
          <s-drop-zone
            ref={dropZoneRef as never}
            label="Upload skill (.md)"
            accept=".md"
            {...(isBusy ? { disabled: true } : {})}
            onChange={handleUpload as never}
          ></s-drop-zone>
          {notice && (
            <s-banner tone="warning" dismissible>
              {notice}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Your skills">
        {skills.length === 0 ? (
          <s-paragraph color="subdued">
            No skills yet. Upload a .md file above to create your first one.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header>Trigger</s-table-header>
              <s-table-header>Updated</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {skills.map((skill) => (
                <s-table-row key={skill.id}>
                  <s-table-cell>{skill.name}</s-table-cell>
                  <s-table-cell>/{skill.trigger}</s-table-cell>
                  <s-table-cell>{formatDate(skill.updatedAt)}</s-table-cell>
                  <s-table-cell>{formatDate(skill.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-button-group>
                      <s-button variant="tertiary" icon="edit" onClick={() => openEdit(skill as SkillRow)}>
                        Edit
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        onClick={() => openDelete(skill as SkillRow)}
                      >
                        Delete
                      </s-button>
                    </s-button-group>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* Edit modal */}
      <s-modal id={EDIT_MODAL_ID} heading="Edit skill">
        <s-stack direction="block" gap="base">
          <s-text-field ref={nameRef as never} label="Name" name="name"></s-text-field>
          <s-text-field
            ref={triggerRef as never}
            label="Trigger"
            name="trigger"
            details="Typed in chat as /trigger. Lowercase letters, numbers, and dashes."
          ></s-text-field>
          <s-text-area
            ref={instructionsRef as never}
            label="Instructions"
            name="instructions"
            rows={10}
          ></s-text-area>
        </s-stack>
        <s-button slot="primary-action" variant="primary" onClick={saveEdit}>
          Save
        </s-button>
        <s-button slot="secondary-actions" commandFor={EDIT_MODAL_ID} command="--hide">
          Cancel
        </s-button>
      </s-modal>

      {/* Delete confirmation modal */}
      <s-modal id={DELETE_MODAL_ID} heading="Delete skill?">
        <s-paragraph>
          {deleting
            ? `Delete "${deleting.name}" (/${deleting.trigger})? This cannot be undone.`
            : ""}
        </s-paragraph>
        <s-button slot="primary-action" variant="primary" tone="critical" onClick={confirmDelete}>
          Delete
        </s-button>
        <s-button slot="secondary-actions" commandFor={DELETE_MODAL_ID} command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
