
-- Missions
create table public.missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null default 'Untitled mission',
  goal text not null,
  status text not null default 'draft', -- draft | running | paused | completed | failed
  current_phase text, -- planning | implement | review | done
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.missions enable row level security;

create policy missions_select_own on public.missions for select using (auth.uid() = user_id);
create policy missions_insert_own on public.missions for insert with check (auth.uid() = user_id);
create policy missions_update_own on public.missions for update using (auth.uid() = user_id);
create policy missions_delete_own on public.missions for delete using (auth.uid() = user_id);

create trigger missions_set_updated_at
  before update on public.missions
  for each row execute function public.set_updated_at();

-- Mission phases
create table public.mission_phases (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  user_id uuid not null,
  phase_type text not null, -- planning | implement | review
  persona text not null, -- conductor | planner | implementer | reviewer
  provider text not null,
  model text not null,
  input text not null default '',
  output text not null default '',
  status text not null default 'pending', -- pending | running | completed | failed
  position int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.mission_phases enable row level security;

create policy mission_phases_select_own on public.mission_phases for select using (auth.uid() = user_id);
create policy mission_phases_insert_own on public.mission_phases for insert with check (auth.uid() = user_id);
create policy mission_phases_update_own on public.mission_phases for update using (auth.uid() = user_id);
create policy mission_phases_delete_own on public.mission_phases for delete using (auth.uid() = user_id);

create index mission_phases_mission_idx on public.mission_phases(mission_id, position);
