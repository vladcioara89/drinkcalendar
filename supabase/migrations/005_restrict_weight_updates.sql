-- Run once in the Supabase SQL editor. Restricts updating a friends row
-- (used for the weight_kg field) to that friend's own linked account —
-- everyone can still read the full list, add/remove is unaffected.
drop policy if exists "signed in write f" on friends;

create policy "insert friends" on friends for insert to authenticated with check (true);
create policy "delete friends" on friends for delete to authenticated using (true);
create policy "update own friend row" on friends for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
