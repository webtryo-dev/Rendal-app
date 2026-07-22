-- Phase 6: image generation (gpt-image-2) storage.
-- The cofounder snake_case UUID tables are managed directly in Supabase (they
-- carry RLS + check constraints and are not part of Prisma Migrate). Apply this
-- in the Supabase SQL editor once; `prisma generate` alone does not create it.

create table if not exists public.generated_images (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops (id) on delete cascade,
  prompt     text not null,
  mime_type  text not null,
  data       text not null,
  width      integer,
  height     integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_generated_images_shop_id
  on public.generated_images (shop_id);

-- Match the RLS posture of the other cofounder tables (server-side access via
-- the service role only; no direct client access).
alter table public.generated_images enable row level security;
