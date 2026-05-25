
-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  default_provider text,
  default_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Updated_at trigger function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- API keys
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  label text not null default '',
  api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index api_keys_user_idx on public.api_keys(user_id);
alter table public.api_keys enable row level security;

create policy "api_keys_select_own" on public.api_keys for select using (auth.uid() = user_id);
create policy "api_keys_insert_own" on public.api_keys for insert with check (auth.uid() = user_id);
create policy "api_keys_update_own" on public.api_keys for update using (auth.uid() = user_id);
create policy "api_keys_delete_own" on public.api_keys for delete using (auth.uid() = user_id);

create trigger api_keys_set_updated_at before update on public.api_keys
  for each row execute function public.set_updated_at();

-- Conversations
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  provider text not null,
  model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_idx on public.conversations(user_id, updated_at desc);
alter table public.conversations enable row level security;

create policy "conversations_select_own" on public.conversations for select using (auth.uid() = user_id);
create policy "conversations_insert_own" on public.conversations for insert with check (auth.uid() = user_id);
create policy "conversations_update_own" on public.conversations for update using (auth.uid() = user_id);
create policy "conversations_delete_own" on public.conversations for delete using (auth.uid() = user_id);

create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

-- Messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_conv_idx on public.messages(conversation_id, created_at);
alter table public.messages enable row level security;

create policy "messages_select_own" on public.messages for select using (auth.uid() = user_id);
create policy "messages_insert_own" on public.messages for insert with check (auth.uid() = user_id);
create policy "messages_delete_own" on public.messages for delete using (auth.uid() = user_id);
