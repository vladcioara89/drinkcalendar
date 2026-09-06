-- The Tab — run this once in your Supabase project's SQL editor
-- (Project → SQL Editor → New query → paste all of this → Run)

create table friends (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#E8A33D',
  weight_kg numeric not null default 75, -- used for the rough BAC estimate
  auth_user_id uuid unique references auth.users(id), -- links to their login, see README
  created_at timestamptz default now()
);

create table entries (
  id uuid primary key default gen_random_uuid(),
  friend_id uuid not null references friends(id) on delete cascade,
  day date not null,
  beer int not null default 0,       -- 500 ml bottles
  beer_small int not null default 0, -- 300 ml bottles
  wine int not null default 0,     -- 150 ml glasses
  rum int not null default 0,      -- 50 ml shots
  whisky int not null default 0,
  vodka int not null default 0,
  excuse text,                     -- filled in only when nothing was drunk
  updated_at timestamptz default now(),
  unique (friend_id, day)
);

-- pure alcohol in ml, so beer vs shots compare fairly
create view entry_units as
select *, (beer*25 + beer_small*15 + wine*18 + rum*20 + whisky*20 + vodka*20) / 10.0 as units
from entries;

-- monthly leaderboard
create view monthly_board as
select date_trunc('month', day) as month,
       friend_id,
       sum(units) as units,
       count(*) filter (where units > 0) as drinking_days,
       count(*) filter (where units = 0) as dry_days
from entry_units
group by 1, 2;

-- RLS: any signed-in person can read everything (shared calendar/ranking),
-- but can only write entries that belong to their own linked friend row.
alter table friends enable row level security;
alter table entries enable row level security;

create policy "signed in read" on entries for select to authenticated using (true);
create policy "own write" on entries for all to authenticated
  using (friend_id in (select id from friends where auth_user_id = auth.uid()))
  with check (friend_id in (select id from friends where auth_user_id = auth.uid()));

create policy "signed in read f" on friends for select to authenticated using (true);
create policy "insert friends" on friends for insert to authenticated with check (true);
create policy "delete friends" on friends for delete to authenticated using (true);
create policy "update own friend row" on friends for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- WhatsApp-style emoji reactions on excuses. One reaction per (entry,
-- reactor) — picking a new emoji replaces your old one.
create table excuse_reactions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references entries(id) on delete cascade,
  reactor_friend_id uuid not null references friends(id) on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
  unique (entry_id, reactor_friend_id)
);

alter table excuse_reactions enable row level security;

create policy "signed in read reactions" on excuse_reactions
  for select to authenticated using (true);
create policy "own reactions" on excuse_reactions for all to authenticated
  using (reactor_friend_id in (select id from friends where auth_user_id = auth.uid()))
  with check (reactor_friend_id in (select id from friends where auth_user_id = auth.uid()));
