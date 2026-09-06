-- Run once in the Supabase SQL editor for an already-deployed project.
alter table entries add column beer_small int not null default 0;

drop view if exists monthly_board;
drop view if exists entry_units;

create view entry_units as
select *, (beer*25 + beer_small*15 + wine*18 + rum*20 + whisky*20 + vodka*20) / 10.0 as units
from entries;

create view monthly_board as
select date_trunc('month', day) as month,
       friend_id,
       sum(units) as units,
       count(*) filter (where units > 0) as drinking_days,
       count(*) filter (where units = 0) as dry_days
from entry_units
group by 1, 2;
