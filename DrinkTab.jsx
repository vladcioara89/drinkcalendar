import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  THE TAB — a shared drinking log for a group of friends            */
/* ------------------------------------------------------------------ */

const KEY = "thetab_v1";

const DRINKS = [
  { id: "beer", label: "Beer", serving: "500 ml", ml: 25 },
  { id: "wine", label: "Wine", serving: "150 ml", ml: 18 },
  { id: "rum", label: "Rum", serving: "50 ml", ml: 20 },
  { id: "whisky", label: "Whisky", serving: "50 ml", ml: 20 },
  { id: "vodka", label: "Vodka", serving: "50 ml", ml: 20 },
];

const PALETTE = [
  "#E8A33D", "#D2603A", "#A8324A", "#79B48C",
  "#5FA8C7", "#C9A0D0", "#E5D8A8", "#8E7CC3",
];

const EXCUSES = [
  "Driving", "Hungover", "Gym tomorrow", "Sick",
  "Broke", "Working", "Family thing", "Just didn't",
];

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

/* --------------------------- helpers ------------------------------ */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => ymd(new Date());

function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const total = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  return cells;
}

const unitsOf = (drinks) =>
  DRINKS.reduce((s, d) => s + (drinks?.[d.id] || 0) * d.ml, 0) / 10;

const fmt = (u) => (u >= 10 ? Math.round(u) : Math.round(u * 10) / 10);

const uid = () => Math.random().toString(36).slice(2, 9);

const emptyData = () => ({
  friends: [
    { id: uid(), name: "You", color: PALETTE[0] },
  ],
  entries: {},
});

/* ---------------------------- app --------------------------------- */

export default function App() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("calendar");
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [openDay, setOpenDay] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(KEY, true);
        setData(res ? JSON.parse(res.value) : emptyData());
      } catch {
        setData(emptyData());
      }
      setStatus("ready");
    })();
  }, []);

  const commit = useCallback(async (next) => {
    setData(next);
    setSaving(true);
    try {
      await window.storage.set(KEY, JSON.stringify(next), true);
    } catch {
      setStatus("error");
    }
    setSaving(false);
  }, []);

  const monthPrefix = `${cursor.y}-${pad(cursor.m + 1)}`;

  const totals = useMemo(() => {
    if (!data) return [];
    const acc = data.friends.map((f) => ({
      ...f, units: 0, days: 0, dry: 0, excuses: [],
    }));
    const byId = Object.fromEntries(acc.map((a) => [a.id, a]));
    Object.entries(data.entries).forEach(([date, perFriend]) => {
      if (!date.startsWith(monthPrefix)) return;
      Object.entries(perFriend).forEach(([fid, e]) => {
        const row = byId[fid];
        if (!row) return;
        const u = unitsOf(e.drinks);
        if (u > 0) { row.units += u; row.days += 1; }
        else { row.dry += 1; if (e.excuse) row.excuses.push({ date, text: e.excuse }); }
      });
    });
    return acc.sort((a, b) => b.units - a.units);
  }, [data, monthPrefix]);

  if (status === "loading" || !data) {
    return (
      <div className="tabapp">
        <Style />
        <div className="empty">Opening the tab…</div>
      </div>
    );
  }

  const shift = (n) => {
    const d = new Date(cursor.y, cursor.m + n, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };

  return (
    <div className="tabapp">
      <Style />

      <header className="head">
        <div className="monthrow">
          <button className="arrow" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <div>
            <h1 className="month">{MONTHS[cursor.m]}</h1>
            <div className="year">{cursor.y}</div>
          </div>
          <button className="arrow" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
        <p className="lede">
          {totals[0] && totals[0].units > 0
            ? <>Leading the month: <b style={{ color: totals[0].color }}>{totals[0].name}</b>, {fmt(totals[0].units)} units</>
            : <>Nothing logged yet this month.</>}
          {saving && <span className="sync"> · saving</span>}
        </p>
      </header>

      <main className="body">
        {tab === "calendar" && (
          <Calendar data={data} cursor={cursor} onPick={setOpenDay} />
        )}
        {tab === "ranking" && <Ranking totals={totals} />}
        {tab === "excuses" && <Excuses totals={totals} />}
        {tab === "friends" && <Friends data={data} commit={commit} />}
      </main>

      <nav className="tabs">
        {[
          ["calendar", "Calendar"],
          ["ranking", "Ranking"],
          ["excuses", "Excuses"],
          ["friends", "Friends"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "tabbtn on" : "tabbtn"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {openDay && (
        <DaySheet
          date={openDay}
          data={data}
          commit={commit}
          close={() => setOpenDay(null)}
        />
      )}
    </div>
  );
}

/* -------------------------- calendar ------------------------------ */

function Calendar({ data, cursor, onPick }) {
  const cells = monthGrid(cursor.y, cursor.m);
  const t = todayKey();

  return (
    <div>
      <div className="grid heads">
        {WEEK.map((w, i) => <div key={i} className="wd">{w}</div>)}
      </div>
      <div className="grid">
        {cells.map((date, i) => {
          if (!date) return <div key={i} />;
          const per = data.entries[date] || {};
          const marks = data.friends
            .map((f) => {
              const e = per[f.id];
              if (!e) return null;
              const u = unitsOf(e.drinks);
              return { color: f.color, wet: u > 0 };
            })
            .filter(Boolean);
          const total = Object.values(per).reduce((s, e) => s + unitsOf(e.drinks), 0);
          const heat = Math.min(total / 25, 1);
          return (
            <button
              key={date}
              className={"day" + (date === t ? " today" : "")}
              onClick={() => onPick(date)}
              style={{ background: `rgba(232,163,61,${heat * 0.28})` }}
            >
              <span className="dnum">{Number(date.slice(8))}</span>
              <span className="dots">
                {marks.slice(0, 8).map((m, j) => (
                  <i
                    key={j}
                    style={
                      m.wet
                        ? { background: m.color }
                        : { border: `1.5px solid ${m.color}` }
                    }
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <p className="legend">
        Filled dot = drank. Hollow dot = dry day with a reason. Tap any day to log.
      </p>
    </div>
  );
}

/* -------------------------- day sheet ----------------------------- */

function DaySheet({ date, data, commit, close }) {
  const [editing, setEditing] = useState(null);
  const d = new Date(date + "T00:00:00");
  const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const per = data.entries[date] || {};

  const save = async (fid, entry) => {
    const next = {
      ...data,
      entries: { ...data.entries, [date]: { ...per, [fid]: entry } },
    };
    await commit(next);
    setEditing(null);
  };

  const clear = async (fid) => {
    const copy = { ...per };
    delete copy[fid];
    const entries = { ...data.entries };
    if (Object.keys(copy).length) entries[date] = copy;
    else delete entries[date];
    await commit({ ...data, entries });
    setEditing(null);
  };

  return (
    <div className="scrim" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheethead">
          <div>
            <h2>{label}</h2>
            <p>What did everyone do?</p>
          </div>
          <button className="x" onClick={close} aria-label="Close">✕</button>
        </div>

        <div className="rows">
          {data.friends.map((f) => {
            const e = per[f.id];
            const u = e ? unitsOf(e.drinks) : 0;
            if (editing === f.id) {
              return (
                <Editor
                  key={f.id}
                  friend={f}
                  entry={e}
                  onSave={(x) => save(f.id, x)}
                  onClear={() => clear(f.id)}
                  onCancel={() => setEditing(null)}
                />
              );
            }
            return (
              <button key={f.id} className="row" onClick={() => setEditing(f.id)}>
                <i className="chip" style={{ background: f.color }} />
                <span className="rname">{f.name}</span>
                <span className="rstate">
                  {!e && <em>not logged</em>}
                  {e && u > 0 && <b>{fmt(u)} units</b>}
                  {e && u === 0 && <span className="dry">{e.excuse || "dry day"}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Editor({ friend, entry, onSave, onClear, onCancel }) {
  const [mode, setMode] = useState(
    entry ? (unitsOf(entry.drinks) > 0 ? "drank" : "dry") : "drank"
  );
  const [drinks, setDrinks] = useState(entry?.drinks || {});
  const [excuse, setExcuse] = useState(entry?.excuse || "");

  const bump = (id, n) =>
    setDrinks((p) => {
      const v = Math.max(0, (p[id] || 0) + n);
      const next = { ...p };
      if (v) next[id] = v; else delete next[id];
      return next;
    });

  const total = unitsOf(drinks);

  return (
    <div className="editor">
      <div className="ehead">
        <i className="chip" style={{ background: friend.color }} />
        <span className="rname">{friend.name}</span>
      </div>

      <div className="seg">
        <button className={mode === "drank" ? "on" : ""} onClick={() => setMode("drank")}>Drank</button>
        <button className={mode === "dry" ? "on" : ""} onClick={() => setMode("dry")}>Didn't drink</button>
      </div>

      {mode === "drank" ? (
        <div className="counters">
          {DRINKS.map((dk) => (
            <div key={dk.id} className="counter">
              <div className="clabel">
                {dk.label}<small>{dk.serving}</small>
              </div>
              <div className="stepper">
                <button onClick={() => bump(dk.id, -1)} aria-label={`One less ${dk.label}`}>−</button>
                <span>{drinks[dk.id] || 0}</span>
                <button onClick={() => bump(dk.id, 1)} aria-label={`One more ${dk.label}`}>+</button>
              </div>
            </div>
          ))}
          <div className="totline">{fmt(total)} units of pure alcohol</div>
        </div>
      ) : (
        <div className="excuse">
          <div className="chips">
            {EXCUSES.map((x) => (
              <button
                key={x}
                className={excuse === x ? "pill on" : "pill"}
                onClick={() => setExcuse(x)}
              >
                {x}
              </button>
            ))}
          </div>
          <input
            value={excuse}
            onChange={(e) => setExcuse(e.target.value)}
            placeholder="Or type the real reason"
          />
        </div>
      )}

      <div className="acts">
        <button className="ghost" onClick={onCancel}>Cancel</button>
        {entry && <button className="ghost" onClick={onClear}>Delete</button>}
        <button
          className="primary"
          onClick={() =>
            onSave(
              mode === "drank"
                ? { drinks, excuse: null }
                : { drinks: {}, excuse: excuse.trim() || "no reason given" }
            )
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* --------------------------- ranking ------------------------------ */

function Ranking({ totals }) {
  const max = Math.max(...totals.map((t) => t.units), 1);
  const any = totals.some((t) => t.units > 0);
  if (!any) return <p className="empty">No drinks logged this month. The board fills up as people log days.</p>;
  return (
    <ol className="board">
      {totals.map((t, i) => (
        <li key={t.id}>
          <div className="brank">{i + 1}</div>
          <div className="bmain">
            <div className="bname">
              <span>{t.name}</span>
              <b>{fmt(t.units)}</b>
            </div>
            <div className="btrack">
              <div style={{ width: `${(t.units / max) * 100}%`, background: t.color }} />
            </div>
            <div className="bmeta">
              {t.days} drinking {t.days === 1 ? "day" : "days"} · {t.dry} dry
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------- excuses ------------------------------ */

function Excuses({ totals }) {
  const all = totals
    .flatMap((t) => t.excuses.map((e) => ({ ...e, name: t.name, color: t.color })))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!all.length) return <p className="empty">No dry days logged yet. Reasons show up here.</p>;
  return (
    <ul className="exlist">
      {all.map((e, i) => (
        <li key={i}>
          <div className="exday">{Number(e.date.slice(8))}</div>
          <div>
            <div className="exwho" style={{ color: e.color }}>{e.name}</div>
            <div className="extext">{e.text}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------- friends ------------------------------ */

function Friends({ data, commit }) {
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n) return;
    commit({
      ...data,
      friends: [
        ...data.friends,
        { id: uid(), name: n, color: PALETTE[data.friends.length % PALETTE.length] },
      ],
    });
    setName("");
  };
  const remove = (id) => {
    const entries = {};
    Object.entries(data.entries).forEach(([d, per]) => {
      const copy = { ...per };
      delete copy[id];
      if (Object.keys(copy).length) entries[d] = copy;
    });
    commit({ ...data, friends: data.friends.filter((f) => f.id !== id), entries });
  };
  return (
    <div>
      <div className="addrow">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a name"
        />
        <button className="primary" onClick={add}>Add</button>
      </div>
      <ul className="flist">
        {data.friends.map((f) => (
          <li key={f.id}>
            <i className="chip" style={{ background: f.color }} />
            <span>{f.name}</span>
            <button className="ghost sm" onClick={() => remove(f.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <p className="legend">
        Everyone opening this app sees and edits the same list. One unit = 10 ml of pure
        alcohol, so a beer counts as 2.5 and a shot as 2.
      </p>
    </div>
  );
}

/* ---------------------------- style ------------------------------- */

function Style() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Anton&family=Karla:wght@400;600;800&display=swap');

.tabapp {
  --ink:#10201A; --panel:#1A2E26; --line:#2B4438;
  --bone:#F1EADC; --mute:#93A89B; --amber:#E8A33D; --sage:#79B48C;
  max-width:440px; margin:0 auto; min-height:100vh;
  background:var(--ink); color:var(--bone);
  font-family:Karla, ui-sans-serif, system-ui, sans-serif;
  display:flex; flex-direction:column; position:relative;
}
.tabapp *{box-sizing:border-box}
.tabapp button{font:inherit; cursor:pointer; border:none; background:none; color:inherit}
.tabapp button:focus-visible, .tabapp input:focus-visible{outline:2px solid var(--amber); outline-offset:2px}
.tabapp input{
  font:inherit; background:var(--panel); border:1px solid var(--line);
  color:var(--bone); border-radius:8px; padding:11px 12px; width:100%;
}
.tabapp input::placeholder{color:var(--mute)}

.head{padding:22px 18px 14px; border-bottom:1px solid var(--line)}
.monthrow{display:flex; align-items:center; justify-content:space-between}
.monthrow > div{text-align:center}
.month{font-family:Anton, Impact, sans-serif; font-size:40px; line-height:.92;
  letter-spacing:.02em; margin:0; text-transform:uppercase}
.year{font-size:12px; letter-spacing:.24em; color:var(--mute); margin-top:5px}
.arrow{font-size:30px; color:var(--mute); padding:0 12px; line-height:1}
.arrow:hover{color:var(--bone)}
.lede{margin:14px 0 0; font-size:14px; color:var(--mute); text-align:center}
.lede b{font-weight:800}
.sync{color:var(--amber)}

.body{flex:1; padding:16px 14px 92px}

.grid{display:grid; grid-template-columns:repeat(7,1fr); gap:5px}
.heads{margin-bottom:6px}
.wd{text-align:center; font-size:11px; color:var(--mute); letter-spacing:.1em}
.day{
  aspect-ratio:1; border:1px solid var(--line); border-radius:9px;
  display:flex; flex-direction:column; align-items:center; justify-content:space-between;
  padding:5px 3px 6px;
}
.day:hover{border-color:var(--amber)}
.day.today{border-color:var(--bone)}
.dnum{font-size:13px; font-weight:600}
.dots{display:flex; flex-wrap:wrap; gap:2px; justify-content:center; max-width:100%}
.dots i{width:6px; height:6px; border-radius:50%; display:block}
.legend{font-size:12px; color:var(--mute); line-height:1.5; margin-top:16px}

.empty{padding:48px 20px; text-align:center; color:var(--mute); font-size:14px}

.tabs{
  position:fixed; bottom:0; left:0; right:0; max-width:440px; margin:0 auto;
  display:grid; grid-template-columns:repeat(4,1fr);
  background:var(--panel); border-top:1px solid var(--line);
}
.tabbtn{padding:15px 4px 20px; font-size:13px; color:var(--mute)}
.tabbtn.on{color:var(--amber); font-weight:800; box-shadow:inset 0 2px 0 var(--amber)}

.scrim{position:fixed; inset:0; background:rgba(6,14,11,.72); display:flex;
  align-items:flex-end; justify-content:center; z-index:20}
.sheet{width:100%; max-width:440px; max-height:88vh; overflow:auto;
  background:var(--ink); border-top:2px solid var(--amber);
  border-radius:16px 16px 0 0; padding:18px 16px 28px}
.sheethead{display:flex; justify-content:space-between; align-items:flex-start; gap:12px}
.sheethead h2{font-family:Anton, Impact, sans-serif; font-size:26px; margin:0;
  text-transform:uppercase; letter-spacing:.02em}
.sheethead p{margin:4px 0 0; font-size:13px; color:var(--mute)}
.x{font-size:18px; color:var(--mute)}

.rows{margin-top:16px; display:flex; flex-direction:column; gap:8px}
.row{display:flex; align-items:center; gap:10px; width:100%;
  padding:13px 12px; border:1px solid var(--line); border-radius:10px; text-align:left}
.row:hover{border-color:var(--amber)}
.chip{width:11px; height:11px; border-radius:50%; flex:none; display:block}
.rname{font-weight:600; font-size:15px}
.rstate{margin-left:auto; font-size:13px; color:var(--mute)}
.rstate b{color:var(--amber); font-weight:800}
.dry{color:var(--sage)}
.rstate em{font-style:normal; opacity:.7}

.editor{border:1px solid var(--amber); border-radius:10px; padding:14px 12px; background:var(--panel)}
.ehead{display:flex; align-items:center; gap:10px; margin-bottom:12px}
.seg{display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:14px}
.seg button{padding:10px; border:1px solid var(--line); border-radius:8px;
  font-size:14px; color:var(--mute)}
.seg button.on{background:var(--bone); color:var(--ink); font-weight:800; border-color:var(--bone)}

.counter{display:flex; align-items:center; justify-content:space-between; padding:7px 0}
.clabel{font-size:15px}
.clabel small{display:block; font-size:11px; color:var(--mute)}
.stepper{display:flex; align-items:center; gap:6px}
.stepper button{width:36px; height:36px; border:1px solid var(--line); border-radius:8px; font-size:18px}
.stepper button:hover{border-color:var(--amber)}
.stepper span{min-width:26px; text-align:center; font-weight:800; font-size:16px}
.totline{margin-top:10px; padding-top:10px; border-top:1px solid var(--line);
  font-size:13px; color:var(--amber); font-weight:600}

.chips{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px}
.pill{padding:8px 11px; border:1px solid var(--line); border-radius:999px; font-size:13px; color:var(--mute)}
.pill.on{background:var(--sage); color:var(--ink); border-color:var(--sage); font-weight:600}

.acts{display:flex; gap:8px; margin-top:16px}
.primary{background:var(--amber); color:var(--ink); font-weight:800;
  padding:11px 18px; border-radius:8px; margin-left:auto}
.ghost{padding:11px 14px; border:1px solid var(--line); border-radius:8px;
  font-size:14px; color:var(--mute)}
.ghost.sm{padding:6px 10px; font-size:12px; margin-left:auto}

.board{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:16px}
.board li{display:flex; gap:12px; align-items:flex-start}
.brank{font-family:Anton, Impact, sans-serif; font-size:26px; color:var(--line); min-width:26px}
.board li:first-child .brank{color:var(--amber)}
.bmain{flex:1}
.bname{display:flex; justify-content:space-between; font-size:15px; font-weight:600}
.bname b{font-family:Anton, Impact, sans-serif; font-weight:400; font-size:20px}
.btrack{height:9px; background:var(--panel); border-radius:5px; margin:6px 0 5px; overflow:hidden}
.btrack div{height:100%; border-radius:5px}
.bmeta{font-size:12px; color:var(--mute)}

.exlist{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px}
.exlist li{display:flex; gap:14px; padding:12px 2px; border-bottom:1px solid var(--line)}
.exday{font-family:Anton, Impact, sans-serif; font-size:20px; color:var(--mute); min-width:28px}
.exwho{font-size:13px; font-weight:600}
.extext{font-size:15px; margin-top:2px}

.addrow{display:flex; gap:8px; margin-bottom:18px}
.addrow .primary{margin-left:0; white-space:nowrap}
.flist{list-style:none; margin:0; padding:0}
.flist li{display:flex; align-items:center; gap:10px; padding:13px 2px; border-bottom:1px solid var(--line); font-size:15px}

@media (prefers-reduced-motion: reduce){ .tabapp *{transition:none !important} }
`}</style>
  );
}
