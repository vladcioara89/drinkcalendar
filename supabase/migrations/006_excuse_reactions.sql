-- Run once in the Supabase SQL editor. WhatsApp-style emoji reactions on
-- other people's excuses. One reaction per (entry, reactor) — picking a
-- new emoji replaces your old one on that entry.
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
