-- Phase 8: customer CSV exports (sensitive PII, 24h expiry).
-- Cofounder tables are managed directly in Supabase (RLS + not in Prisma
-- Migrate). Apply this in the Supabase SQL editor once; `prisma generate`
-- alone does not create it.

create table if not exists public.customer_exports (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops (id) on delete cascade,
  filename   text not null,
  data       text not null,
  row_count  integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_customer_exports_shop_id
  on public.customer_exports (shop_id);

-- Helps the lazy-expiry sweep (delete where expires_at < now()).
create index if not exists idx_customer_exports_expires_at
  on public.customer_exports (expires_at);

alter table public.customer_exports enable row level security;
