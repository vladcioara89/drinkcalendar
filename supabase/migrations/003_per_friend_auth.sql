-- Run once in the Supabase SQL editor for an already-deployed project,
-- AFTER creating each friend's auth user (see README.md "Individual PINs").

alter table friends add column auth_user_id uuid unique references auth.users(id);

-- Anyone signed in can still read everything (shared calendar/ranking),
-- but can only insert/update/delete entries that belong to their own
-- linked friend row.
drop policy if exists "signed in write" on entries;

create policy "own write" on entries for all to authenticated
  using (friend_id in (select id from friends where auth_user_id = auth.uid()))
  with check (friend_id in (select id from friends where auth_user_id = auth.uid()));

-- Then link each friend row to their auth user, e.g.:
-- update friends set auth_user_id = (select id from auth.users where email = 'csnn@thetab.local') where name = 'CSNN';
-- update friends set auth_user_id = (select id from auth.users where email = 'drughi@thetab.local') where name = 'Drughi';
-- update friends set auth_user_id = (select id from auth.users where email = 'pax@thetab.local') where name = 'PAX';
