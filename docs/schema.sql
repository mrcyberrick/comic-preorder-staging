-- ============================================================
-- Comic Pre-Order System — Supabase Database Schema
-- Run this entire file in the Supabase SQL Editor
-- Last updated: 2026-02
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- TABLE: catalog
-- Unified table for both Lunar and PRH items
-- Replaced monthly via import script (import-catalog.ps1)
-- All fields map directly to normalized_catalog.json
-- ------------------------------------------------------------
create table if not exists catalog (
  id              uuid primary key default uuid_generate_v4(),
  distributor     text not null check (distributor in ('Lunar', 'PRH')),
  item_code       text not null,           -- Lunar: Code / PRH: MainIdentifier
  alternate_code  text,                    -- Lunar: AlternateLunarCode / PRH: UPC
  upc             text,
  isbn            text,
  title           text not null,
  series_name     text,
  series_number   text,
  publisher       text,
  imprint         text,
  format          text,                    -- "Comic Book", "Trade Paperback", etc.
  comic_type      text,                    -- "ONGOING", "MINISERIES", etc.
  variant_type    text,
  variant_desc    text,
  issue_number    text,
  price_usd       numeric(6,2),
  foc_date        date,
  on_sale_date    date,
  writer          text,
  artist          text,
  cover_artist    text,
  description     text,
  cover_url       text,
  rating          text,
  is_mature       boolean default false,
  catalog_month   text not null,           -- e.g., "2026-03"
  created_at      timestamptz default now()
);

-- Index for fast filtering
create index if not exists idx_catalog_distributor on catalog(distributor);
create index if not exists idx_catalog_publisher on catalog(publisher);
create index if not exists idx_catalog_on_sale on catalog(on_sale_date);
create index if not exists idx_catalog_month on catalog(catalog_month);
create index if not exists idx_catalog_series on catalog(series_name);

-- ------------------------------------------------------------
-- TABLE: user_profiles
-- Extends Supabase auth.users with app-specific fields
-- ------------------------------------------------------------
create table if not exists user_profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  full_name        text not null,
  is_admin         boolean default false,
  created_by_admin boolean default true,
  notes            text,                   -- internal notes about customer
  created_at       timestamptz default now()
);

-- ------------------------------------------------------------
-- TABLE: preorders
-- One row per customer reservation
-- quantity added to support multi-copy reservations
-- ------------------------------------------------------------
create table if not exists preorders (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  catalog_id  uuid not null references catalog(id) on delete cascade,
  quantity    integer not null default 1 check (quantity > 0),
  created_at  timestamptz default now(),
  notes       text,                        -- optional customer note
  unique(user_id, catalog_id)             -- prevent duplicate reservations
);

create index if not exists idx_preorders_user on preorders(user_id);
create index if not exists idx_preorders_catalog on preorders(catalog_id);

-- ------------------------------------------------------------
-- TABLE: app_settings
-- Key/value store for site-wide configuration
-- Keys in use:
--   maintenance_mode  — 'true' | 'false'
-- ------------------------------------------------------------
create table if not exists app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

-- Seed default settings
insert into app_settings (key, value)
values ('maintenance_mode', 'false')
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY (RLS)
-- Critical: ensures customers can only see their own pre-orders
-- ------------------------------------------------------------

-- Enable RLS on all tables
alter table catalog enable row level security;
alter table user_profiles enable row level security;
alter table preorders enable row level security;
alter table app_settings enable row level security;

-- CATALOG: Anyone logged in can read the catalog
create policy "Logged in users can view catalog"
  on catalog for select
  using (auth.role() = 'authenticated');

-- CATALOG: Only admins can insert/update/delete
create policy "Admins can modify catalog"
  on catalog for all
  using (
    exists (
      select 1 from user_profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- USER PROFILES: Users can read their own profile
create policy "Users can view own profile"
  on user_profiles for select
  using (auth.uid() = id);

-- USER PROFILES: Admins can view all profiles
create policy "Admins can view all profiles"
  on user_profiles for select
  using (
    exists (
      select 1 from user_profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- USER PROFILES: Admins can insert/update profiles
create policy "Admins can manage profiles"
  on user_profiles for all
  using (
    exists (
      select 1 from user_profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- PREORDERS: Users can view and manage their own pre-orders
create policy "Users can manage own preorders"
  on preorders for all
  using (auth.uid() = user_id);

-- PREORDERS: Admins can view all pre-orders
create policy "Admins can view all preorders"
  on preorders for select
  using (
    exists (
      select 1 from user_profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- APP SETTINGS: Anyone logged in can read settings
create policy "Logged in users can read settings"
  on app_settings for select
  using (auth.role() = 'authenticated');

-- APP SETTINGS: Only admins can update settings
create policy "Admins can update settings"
  on app_settings for all
  using (
    exists (
      select 1 from user_profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- ------------------------------------------------------------
-- HELPER VIEW: admin_preorders
-- Denormalized view for admin reporting
-- ------------------------------------------------------------
create or replace view admin_preorders as
  select
    p.id            as preorder_id,
    p.created_at    as reserved_at,
    p.quantity,
    p.notes         as customer_notes,
    up.full_name    as customer_name,
    u.email         as customer_email,
    c.distributor,
    c.item_code,
    c.title,
    c.series_name,
    c.publisher,
    c.format,
    c.issue_number,
    c.price_usd,
    (c.price_usd * p.quantity) as line_total,
    c.foc_date,
    c.on_sale_date,
    c.catalog_month,
    c.cover_url
  from preorders p
  join auth.users u on u.id = p.user_id
  join user_profiles up on up.id = p.user_id
  join catalog c on c.id = p.catalog_id
  order by up.full_name, c.on_sale_date;

