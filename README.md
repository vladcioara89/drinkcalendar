# The Tab — free stack + deploy guide

A shared drinking log for a small group of friends. Runs on phones as an installable
web app (PWA). No app store, no server bill.

## This scaffold

This folder is the Vite project root (package name `thetab`). It's already wired to
Supabase — no local state left. What's here:

- [vite.config.js](vite.config.js) — React + `vite-plugin-pwa`, manifest pointing at
  the icons in [public/](public).
- [src/lib/supabaseClient.js](src/lib/supabaseClient.js) — reads
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from `.env` and throws a clear error
  if they're missing.
- [src/lib/db.js](src/lib/db.js) — every Supabase query (friends CRUD, entries CRUD,
  scoped to the visible month) plus the row ↔ UI-shape converters.
- [src/App.jsx](src/App.jsx) — the prototype component from
  [DrinkTab.jsx](DrinkTab.jsx), wired to `db.js` instead of `window.storage`, gated
  behind an individual PIN per person (see "Individual PINs" below) — each person
  can view everyone's log but only edit their own. `DrinkTab.jsx` is left at the
  repo root untouched as the original reference.

**Not run yet**: this environment has no Node/npm on PATH, so dependencies were never
installed and the app was never started. Before it'll do anything:

```bash
npm install
cp .env.example .env   # fill in your Supabase project URL + anon key
npm run dev
```

You'll also need to actually create the `friends` / `entries` tables and RLS
policies below in your Supabase project's SQL editor, and add each friend's email
as a user (Authentication → Users) since public signups should stay off.

## The stack (all free)

| Piece | Choice | Why |
|---|---|---|
| App | React + Vite, built as a PWA | Installs to the home screen on iOS and Android. No store review, no $99/yr Apple fee. |
| Hosting | Cloudflare Pages (or Netlify) | Free, unlimited bandwidth, commercial use allowed. Vercel's free Hobby tier bans commercial use — fine here, but Cloudflare has fewer strings. |
| Database + login | Supabase free tier | Postgres, auth, realtime. 500 MB DB, 50k monthly users. Way beyond what 10 friends need. |

Total cost: €0. The only real catch is that **Supabase pauses a free project after
7 days with zero traffic**. If your friends log most days it never triggers. If you
want a guarantee, add a GitHub Action on a cron that pings the project every 3 days.

## Setup, roughly 15 minutes (scaffold + wiring already done)

1. `npm install` in this folder.
2. Create a free Supabase project, run the SQL below in the SQL editor.
3. Put the project URL and anon key in `.env` as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
   (copy `.env.example`), and set up each person's login (see "Individual PINs"
   below).
4. `npm run dev`, sign in with your name and PIN.
5. Push to GitHub, connect the repo in Cloudflare Pages. Build command `npm run build`,
   output directory `dist`.
6. Send your friends the URL. On iPhone: Share → Add to Home Screen. On Android the
   install prompt appears on its own.

## Schema

Also saved as [supabase/schema.sql](supabase/schema.sql) — paste that whole file into
the Supabase SQL editor and run it once.

```sql
create table friends (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#E8A33D',
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
```

Enable RLS: anyone signed in can read everything, but can only write entries that
belong to their own linked friend row (see "Individual PINs" below):

```sql
alter table friends enable row level security;
alter table entries enable row level security;

create policy "signed in read" on entries for select to authenticated using (true);
create policy "own write" on entries for all to authenticated
  using (friend_id in (select id from friends where auth_user_id = auth.uid()))
  with check (friend_id in (select id from friends where auth_user_id = auth.uid()));
create policy "signed in read f"  on friends for select to authenticated using (true);
create policy "signed in write f" on friends for all    to authenticated using (true) with check (true);
```

## Individual PINs

The app is public on the internet, and the RLS policies above require an
`authenticated` Supabase session — without some gate, anyone who finds the URL
could read and edit everyone's log. Each person in the group has their own PIN, and
can only log/edit their own row (enforced by the `own write` RLS policy above, not
just hidden in the UI) — everyone can still see everyone's calendar, ranking, and
excuses.

The login screen asks for a name and PIN. The PIN is a dedicated Supabase auth
user's password; the login email is derived from the name
(`"CSNN"` → `csnn@thetab.local`) so there's no per-person env var to manage.

Set up each person once:

1. Supabase dashboard → Authentication → Users → **Add user** → **Create new user**.
   Email is `<lowercase-name>@thetab.local` (matching exactly how their name is
   typed in the app, lowercased, spaces/punctuation replaced with `-`) — it's never
   actually emailed. Password is their PIN. Check **Auto Confirm User**.
2. Run [supabase/migrations/003_per_friend_auth.sql](supabase/migrations/003_per_friend_auth.sql)
   once (adds `friends.auth_user_id` and the restricted write policy), then run the
   `update friends set auth_user_id = ...` line at the bottom of that file for each
   person you created, matching their email to their friend row's name.

To change someone's PIN later, edit that auth user's password in Authentication →
Users — no app changes needed. A friend row with no linked `auth_user_id` can be
viewed by everyone but can't be edited by anyone (no login maps to it).

## Estimated BAC

Each friend has a `weight_kg` (set when adding them, editable in the Friends tab),
used to show a rough estimated peak blood alcohol % when logging a day — a Widmark
formula estimate assuming the day's drinks all hit at once. This is **not** a real
BAC reading: entries are logged per day, not per drink-with-a-timestamp, so there's
no way to know if those drinks were spread over 6 hours or 20 minutes, which changes
actual BAC enormously. Don't use it to decide whether it's safe to drive.

## Ideas worth adding later

- Realtime subscription so the calendar updates live when someone logs from the bar.
- A nightly push/Telegram bot that pokes whoever hasn't logged yesterday.
- Excuse of the month, voted on by the group.
- Yearly view with a heat map, and a "longest dry streak" stat as a counterweight
  to the leaderboard.
