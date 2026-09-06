-- Run once in the Supabase SQL editor for an already-deployed project.
alter table friends add column weight_kg numeric not null default 75;
