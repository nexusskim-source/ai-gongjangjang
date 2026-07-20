-- ============================================================
--  당근마켓 클론 (잠원동) — Supabase 스키마 + RLS + Storage
--  실행: setup-db.js 가 이 파일을 읽어 순서대로 실행
-- ============================================================

-- ---------- profiles (auth.users 1:1) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  region text not null default '잠원동',
  created_at timestamptz not null default now()
);

-- ---------- products ----------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  price integer not null default 0,
  description text,
  category text not null default '기타',
  region text not null default '잠원동',
  images text[] not null default '{}',        -- 최대 3장 (public URL)
  status text not null default 'onsale',       -- onsale | reserved | sold
  created_at timestamptz not null default now()
);
create index if not exists products_created_idx on public.products (created_at desc);
create index if not exists products_category_idx on public.products (category);

-- ---------- favorites (관심) ----------
create table if not exists public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

-- ---------- chat_rooms (상품별 구매자-판매자 1:1) ----------
create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, buyer_id)
);

-- ---------- messages ----------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_idx on public.messages (room_id, created_at);

-- ============================================================
--  RLS
-- ============================================================
alter table public.profiles   enable row level security;
alter table public.products   enable row level security;
alter table public.favorites  enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.messages   enable row level security;

-- profiles: 누구나 조회, 본인만 생성/수정
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (auth.uid() = id);

-- products: 누구나 조회, 본인만 등록/수정/삭제
drop policy if exists products_select on public.products;
create policy products_select on public.products for select using (true);
drop policy if exists products_insert on public.products;
create policy products_insert on public.products for insert with check (auth.uid() = seller_id);
drop policy if exists products_update on public.products;
create policy products_update on public.products for update using (auth.uid() = seller_id);
drop policy if exists products_delete on public.products;
create policy products_delete on public.products for delete using (auth.uid() = seller_id);

-- favorites: 누구나 조회(관심 수 카운트용), 본인 것만 추가/삭제
drop policy if exists favorites_select on public.favorites;
create policy favorites_select on public.favorites for select using (true);
drop policy if exists favorites_insert on public.favorites;
create policy favorites_insert on public.favorites for insert with check (auth.uid() = user_id);
drop policy if exists favorites_delete on public.favorites;
create policy favorites_delete on public.favorites for delete using (auth.uid() = user_id);

-- chat_rooms: 당사자(구매자/판매자)만 조회, 구매자가 생성
drop policy if exists rooms_select on public.chat_rooms;
create policy rooms_select on public.chat_rooms for select
  using (auth.uid() = buyer_id or auth.uid() = seller_id);
drop policy if exists rooms_insert on public.chat_rooms;
create policy rooms_insert on public.chat_rooms for insert
  with check (auth.uid() = buyer_id);

-- messages: 방 당사자만 조회, 방 당사자이면서 본인이 보낸 것만 작성
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select using (
  exists (
    select 1 from public.chat_rooms r
    where r.id = room_id and (auth.uid() = r.buyer_id or auth.uid() = r.seller_id)
  )
);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert with check (
  auth.uid() = sender_id and exists (
    select 1 from public.chat_rooms r
    where r.id = room_id and (auth.uid() = r.buyer_id or auth.uid() = r.seller_id)
  )
);

-- ============================================================
--  Storage : product-images 버킷 (public read, 인증자 업로드)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "product images auth insert" on storage.objects;
create policy "product images auth insert" on storage.objects for insert
  with check (bucket_id = 'product-images' and auth.role() = 'authenticated');

drop policy if exists "product images owner delete" on storage.objects;
create policy "product images owner delete" on storage.objects for delete
  using (bucket_id = 'product-images' and owner = auth.uid());
