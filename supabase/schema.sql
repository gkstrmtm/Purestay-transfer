-- PureStay storage schema for Supabase Postgres
-- Run this in Supabase SQL Editor.

create table if not exists public.purestay_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists purestay_kv_updated_at_idx on public.purestay_kv (updated_at desc);

create table if not exists public.purestay_logs (
  id bigserial primary key,
  list_key text not null,
  entry jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists purestay_logs_list_key_id_idx on public.purestay_logs (list_key, id desc);

create table if not exists public.purestay_sets (
  set_key text not null,
  member text not null,
  created_at timestamptz not null default now(),
  primary key (set_key, member)
);

create index if not exists purestay_sets_set_key_idx on public.purestay_sets (set_key);
