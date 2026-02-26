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

-- Lock down shared storage tables too.
-- Server-side API should use SUPABASE_SERVICE_ROLE_KEY (service role bypasses RLS).
alter table public.purestay_kv enable row level security;
alter table public.purestay_logs enable row level security;
alter table public.purestay_sets enable row level security;

-- ------------------------------------------------------------
-- Portal (internal) schema
-- Notes:
-- - Intended for use via server-side API with SUPABASE_SERVICE_ROLE_KEY.
-- - RLS is enabled so that accidental anon-key usage does not leak data.

create table if not exists public.portal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null,
  full_name text,
  created_at timestamptz not null default now()
);

create index if not exists portal_profiles_role_idx on public.portal_profiles (role);

create table if not exists public.portal_leads (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  assigned_role text,
  assigned_user_id uuid references auth.users(id) on delete set null,

  source text,
  status text not null default 'new',
  priority int not null default 0,

  first_name text,
  last_name text,
  phone text,
  email text,

  company text,
  property_name text,
  address text,
  city text,
  state text,
  postal_code text,

  notes text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists portal_leads_created_at_idx on public.portal_leads (created_at desc);
create index if not exists portal_leads_status_idx on public.portal_leads (status);
create index if not exists portal_leads_assigned_role_idx on public.portal_leads (assigned_role);
create index if not exists portal_leads_assigned_user_idx on public.portal_leads (assigned_user_id);

create table if not exists public.portal_lead_activities (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  lead_id bigint not null references public.portal_leads(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  activity_type text not null,
  outcome text,
  notes text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists portal_lead_activities_lead_id_idx on public.portal_lead_activities (lead_id, id desc);

create table if not exists public.portal_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  status text not null default 'open',
  title text,
  event_date date,
  start_time text,
  end_time text,
  address text,
  city text,
  state text,
  postal_code text,
  area_tag text,

  assigned_role text,
  assigned_user_id uuid references auth.users(id) on delete set null,

  payout_cents int not null default 0,
  notes text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists portal_events_status_idx on public.portal_events (status);
create index if not exists portal_events_event_date_idx on public.portal_events (event_date desc);
create index if not exists portal_events_assigned_role_idx on public.portal_events (assigned_role);

create table if not exists public.portal_event_recaps (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event_id bigint not null references public.portal_events(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  recap text,
  media_urls text[] not null default '{}'::text[],
  payload jsonb not null default '{}'::jsonb
);

create index if not exists portal_event_recaps_event_id_idx on public.portal_event_recaps (event_id, id desc);

create table if not exists public.portal_payouts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  role text,
  amount_cents int not null default 0,
  status text not null default 'pending',
  period_start date,
  period_end date,
  description text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists portal_payouts_user_id_idx on public.portal_payouts (user_id, id desc);
create index if not exists portal_payouts_status_idx on public.portal_payouts (status);

create table if not exists public.portal_docs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  title text not null,
  audience_role text,
  content text not null,
  source text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists portal_docs_audience_role_idx on public.portal_docs (audience_role);

alter table public.portal_profiles enable row level security;
alter table public.portal_leads enable row level security;
alter table public.portal_lead_activities enable row level security;
alter table public.portal_events enable row level security;
alter table public.portal_event_recaps enable row level security;
alter table public.portal_payouts enable row level security;
alter table public.portal_docs enable row level security;
