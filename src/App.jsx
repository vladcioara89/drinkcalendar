import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient";
import {
  fetchFriends,
  removeFriend as dbRemoveFriend,
  updateFriendWeight as dbUpdateFriendWeight,
  fetchEntries,
  saveEntry as dbSaveEntry,
  deleteEntry as dbDeleteEntry,
  rowsToEntriesMap,
  fetchReactions,
  setReaction,
  clearReaction,
} from "./lib/db";

/* ------------------------------------------------------------------ */
/*  THE TAB — a shared drinking log for a group of friends            */
/*  Backed by Supabase (friends / entries tables), gated behind       */
/*  Supabase magic-link auth per the RLS policies in README.md.       */
/* ------------------------------------------------------------------ */

const DRINKS = [
  { id: "beer", label: "Bere", serving: "500 ml", ml: 25 },
  { id: "beer_small", label: "Bere", serving: "300 ml", ml: 15 },
  { id: "beer_draught", label: "Bere Draught", serving: "500 ml", ml: 25 },
  { id: "wine", label: "Vin", serving: "150 ml", ml: 18 },
  { id: "rum", label: "Rom", serving: "50 ml", ml: 20 },
  { id: "whisky", label: "Whisky", serving: "50 ml", ml: 20 },
  { id: "vodka", label: "Vodcă", serving: "50 ml", ml: 20 },
];

const EXCUSES = [
  "Conduc", "Mahmureală", "Sală mâine", "Bolnav",
  "Fără bani", "Lucrez", "Treabă de familie", "Pur și simplu n-am vrut",
];

const MONTHS = ["Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie",
  "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"];
const WEEK = ["L", "M", "M", "J", "V", "S", "D"];

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

// Romanian plurals for drink labels (2+); anything not listed here (Vin,
// Vodcă) stays the same in plural.
const PLURAL_LABELS = { Bere: "Beri", "Bere Draught": "Beri Draught", Rom: "Romuri", Whisky: "Whisky-uri" };
const pluralLabel = (label, count) => (count === 1 ? label : PLURAL_LABELS[label] || label);

const describeDrinks = (drinks) =>
  DRINKS.filter((d) => drinks?.[d.id] > 0)
    .map((d) => `${drinks[d.id]} ${pluralLabel(d.label, drinks[d.id])} ${d.serving}`)
    .join(", ");

// Summarize a month's aggregated per-drink counts, e.g. "12 Beri + 3 Vin".
// Different servings of the same drink (Bere 500ml / 300ml) are combined
// under one label since the serving size doesn't matter for this summary.
const summarizeDrinkCounts = (counts) => {
  const byLabel = {};
  DRINKS.forEach((d) => {
    const c = counts?.[d.id] || 0;
    if (c) byLabel[d.label] = (byLabel[d.label] || 0) + c;
  });
  const parts = Object.entries(byLabel)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${pluralLabel(label, count)}`);
  return parts.length ? parts.join(" + ") : "—";
};

// Rough Widmark-formula estimate of peak BAC if the day's drinks all hit at
// once — not time-adjusted (we only log daily totals, not when each drink
// happened), so this is a ceiling, not a real reading. Not for deciding
// whether it's safe to drive.
const ETHANOL_DENSITY_G_ML = 0.789;
const WIDMARK_R = 0.68; // average distribution ratio across sexes

function estimateBAC(units, weightKg) {
  const w = weightKg > 0 ? weightKg : 75;
  const gramsAlcohol = units * 10 * ETHANOL_DENSITY_G_ML; // units = (ml pure alcohol) / 10
  const bacPermille = gramsAlcohol / (WIDMARK_R * w);
  return bacPermille / 10; // as a percentage, e.g. 0.08
}

/* ---------------------------- app --------------------------------- */

export default function App() {
  // undefined = still checking for a session, null = signed out
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (session === undefined) {
    return (
      <div className="tabapp">
        <Style />
        <div className="empty">Se deschide tab-ul…</div>
      </div>
    );
  }

  if (!session) return <Login />;

  return <Tab session={session} />;
}

/* ---------------------------- login -------------------------------- */

// Each person has their own Supabase auth user; the PIN is that account's
// password, and the login email is derived from their name
// ("CSNN" -> "csnn@thetab.local"). An admin creates that auth user and
// links it to the friend row's auth_user_id — see README.md.
const slugifyName = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const loginEmailFor = (name) => `${slugifyName(name)}@thetab.local`;

function Login() {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const n = name.trim();
    const p = pin.trim();
    if (!n || !p || busy) return;
    setBusy(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmailFor(n),
      password: p,
    });
    setBusy(false);
    if (error) setError("Nume sau PIN greșit.");
  };

  return (
    <div className="tabapp">
      <Style />
      <div className="empty" style={{ padding: "72px 24px", textAlign: "left" }}>
        <h1 className="month" style={{ fontSize: 32, marginBottom: 18 }}>THE TAB</h1>
        <p style={{ marginBottom: 14 }}>Introdu numele și PIN-ul pentru a vedea tab-ul.</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Numele tău"
          autoFocus
        />
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="PIN"
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          style={{ marginTop: 10 }}
        />
        <button className="primary" style={{ marginTop: 12 }} onClick={submit} disabled={busy}>
          {busy ? "Se verifică…" : "Intră"}
        </button>
        {error && <p style={{ color: "#D2603A", marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}

/* --------------------------- main tab ------------------------------ */

function Tab({ session }) {
  const [friends, setFriends] = useState([]);
  const [entries, setEntries] = useState({}); // { [day]: { [friendId]: {drinks, excuse} } }, scoped to cursor's month
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("calendar");
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [openDay, setOpenDay] = useState(null);

  const monthPrefix = `${cursor.y}-${pad(cursor.m + 1)}`;
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = `${cursor.y}-${pad(cursor.m + 1)}-${pad(new Date(cursor.y, cursor.m + 1, 0).getDate())}`;

  const reloadEntries = useCallback(async () => {
    try {
      const rows = await fetchEntries(monthStart, monthEnd);
      setEntries(rowsToEntriesMap(rows));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [monthStart, monthEnd]);

  useEffect(() => {
    fetchFriends().then(setFriends).catch(() => setStatus("error"));
  }, []);

  const myFriend = useMemo(
    () => friends.find((f) => f.auth_user_id === session.user.id) ?? null,
    [friends, session.user.id]
  );

  useEffect(() => {
    setStatus("loading");
    reloadEntries();
  }, [reloadEntries]);

  const totals = useMemo(() => {
    const acc = friends.map((f) => ({
      ...f, units: 0, days: 0, dry: 0, excuses: [], drinkCounts: {}, totalDrinks: 0,
      maxDayUnits: 0, maxDayDate: null,
    }));
    const byId = Object.fromEntries(acc.map((a) => [a.id, a]));
    Object.entries(entries).forEach(([date, perFriend]) => {
      Object.entries(perFriend).forEach(([fid, e]) => {
        const row = byId[fid];
        if (!row) return;
        const u = unitsOf(e.drinks);
        if (u > 0) {
          row.units += u; row.days += 1;
          if (u > row.maxDayUnits) { row.maxDayUnits = u; row.maxDayDate = date; }
          DRINKS.forEach((d) => {
            const c = e.drinks?.[d.id] || 0;
            if (c) { row.drinkCounts[d.id] = (row.drinkCounts[d.id] || 0) + c; row.totalDrinks += c; }
          });
        } else { row.dry += 1; if (e.excuse) row.excuses.push({ id: e.id, friendId: fid, date, text: e.excuse }); }
      });
    });
    return acc.sort((a, b) => b.units - a.units);
  }, [friends, entries]);

  const lache = useMemo(
    () => (totals.length > 1 ? totals.slice().sort((a, b) => a.totalDrinks - b.totalDrinks)[0] : null),
    [totals]
  );

  const shift = (n) => {
    const d = new Date(cursor.y, cursor.m + n, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setOpenDay(null);
  };

  // Postgres code 42501 = row-level security rejected the write (trying to
  // edit someone else's entry). Rethrow so the caller can show that
  // specifically instead of the generic sync-error banner.
  const saveEntry = useCallback(async (friendId, date, entry) => {
    setSaving(true);
    try {
      await dbSaveEntry(friendId, date, entry);
      await reloadEntries();
    } catch (err) {
      setSaving(false);
      if (err?.code === "42501") throw err;
      setStatus("error");
      return;
    }
    setSaving(false);
  }, [reloadEntries]);

  const clearEntry = useCallback(async (friendId, date) => {
    setSaving(true);
    try {
      await dbDeleteEntry(friendId, date);
      await reloadEntries();
    } catch (err) {
      setSaving(false);
      if (err?.code === "42501") throw err;
      setStatus("error");
      return;
    }
    setSaving(false);
  }, [reloadEntries]);

  const removeFriend = useCallback(async (id) => {
    setSaving(true);
    try {
      await dbRemoveFriend(id);
      setFriends(await fetchFriends());
      await reloadEntries();
    } catch {
      setStatus("error");
    }
    setSaving(false);
  }, [reloadEntries]);

  const updateFriendWeight = useCallback(async (id, weightKg) => {
    setSaving(true);
    try {
      await dbUpdateFriendWeight(id, weightKg);
      setFriends(await fetchFriends());
    } catch (err) {
      setSaving(false);
      if (err?.code === "42501") throw err;
      setStatus("error");
      return;
    }
    setSaving(false);
  }, []);

  if (status === "loading" && friends.length === 0) {
    return (
      <div className="tabapp">
        <Style />
        <div className="empty">Se deschide tab-ul…</div>
      </div>
    );
  }

  return (
    <div className="tabapp">
      <Style />

      <header className="head">
        <div className="monthrow">
          <button className="arrow" onClick={() => shift(-1)} aria-label="Luna precedentă">‹</button>
          <div>
            <h1 className="month">{MONTHS[cursor.m]}</h1>
            <div className="year">{cursor.y}</div>
          </div>
          <button className="arrow" onClick={() => shift(1)} aria-label="Luna următoare">›</button>
        </div>
        <p className="lede">
          {totals[0] && totals[0].units > 0
            ? <>Lider luna aceasta: <b style={{ color: totals[0].color }}>{totals[0].name}</b>, {summarizeDrinkCounts(totals[0].drinkCounts)}</>
            : <>Nimic înregistrat luna aceasta încă.</>}
          {saving && <span className="sync"> · se salvează</span>}
          {status === "error" && <span className="sync" style={{ color: "#D2603A" }}> · eroare de sincronizare</span>}
        </p>
        {lache && (
          <p className="lede">
            Lache luna asta: <b style={{ color: lache.color }}>{lache.name}</b>,{" "}
            {lache.totalDrinks} {lache.totalDrinks === 1 ? "băutură" : "băuturi"}
          </p>
        )}
      </header>

      <main className="body">
        {tab === "calendar" && (
          <Calendar friends={friends} entries={entries} cursor={cursor} onPick={setOpenDay} />
        )}
        {tab === "ranking" && <Ranking totals={totals} />}
        {tab === "excuses" && (
          <Excuses totals={totals} myFriendId={myFriend?.id ?? null} onDelete={clearEntry} />
        )}
        {tab === "friends" && (
          <Friends
            friends={friends}
            myFriendName={myFriend?.name ?? null}
            onRemove={removeFriend}
            onUpdateWeight={updateFriendWeight}
          />
        )}
      </main>

      <nav className="tabs">
        {[
          ["calendar", "Calendar"],
          ["ranking", "Clasament"],
          ["excuses", "Scuze"],
          ["friends", "Prieteni"],
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
          friends={friends}
          entriesForDay={entries[openDay] || {}}
          onSaveEntry={saveEntry}
          onClearEntry={clearEntry}
          close={() => setOpenDay(null)}
        />
      )}
    </div>
  );
}

/* -------------------------- calendar ------------------------------ */

function Calendar({ friends, entries, cursor, onPick }) {
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
          const per = entries[date] || {};
          const marks = friends
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
        Punct plin = a băut. Punct gol = zi fără alcool cu motiv. Apasă pe orice zi pentru a înregistra.
      </p>
    </div>
  );
}

/* -------------------------- day sheet ----------------------------- */

const NOT_YOUR_RECORD_MESSAGE = "MUIE MA, UMBLI CU CIOARA VOPSITA";

function DaySheet({ date, friends, entriesForDay, onSaveEntry, onClearEntry, close }) {
  const [editing, setEditing] = useState(null);
  const [denied, setDenied] = useState(false);
  const d = new Date(date + "T00:00:00");
  const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;

  const save = async (fid, entry) => {
    try {
      await onSaveEntry(fid, date, entry);
      setEditing(null);
      setDenied(false);
    } catch (err) {
      if (err?.code === "42501") setDenied(true);
      else throw err;
    }
  };

  const clear = async (fid) => {
    try {
      await onClearEntry(fid, date);
      setEditing(null);
      setDenied(false);
    } catch (err) {
      if (err?.code === "42501") setDenied(true);
      else throw err;
    }
  };

  return (
    <div className="scrim" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheethead">
          <div>
            <h2>{label}</h2>
            <p>Ce a făcut fiecare?</p>
          </div>
          <button className="x" onClick={close} aria-label="Închide">✕</button>
        </div>

        {denied && <p className="denied">{NOT_YOUR_RECORD_MESSAGE}</p>}

        <div className="rows">
          {friends.map((f) => {
            const e = entriesForDay[f.id];
            const u = e ? unitsOf(e.drinks) : 0;
            if (editing === f.id) {
              return (
                <Editor
                  key={f.id}
                  friend={f}
                  entry={e}
                  onSave={(x) => save(f.id, x)}
                  onClear={() => clear(f.id)}
                  onCancel={() => { setEditing(null); setDenied(false); }}
                />
              );
            }
            return (
              <div key={f.id} className="row">
                <button className="rowmain" onClick={() => { setEditing(f.id); setDenied(false); }}>
                  <i className="chip" style={{ background: f.color }} />
                  <span className="rname">{f.name}</span>
                  <span className="rstate">
                    {!e && <em>Click pentru a înregistra progresul pe ziua asta</em>}
                    {e && u > 0 && <b>{describeDrinks(e.drinks)}</b>}
                    {e && u === 0 && <span className="dry">{e.excuse || "zi fără alcool"}</span>}
                  </span>
                </button>
                {e && (
                  <button className="rowdel" onClick={() => clear(f.id)} aria-label={`Șterge înregistrarea lui ${f.name}`}>
                    <TrashIcon />
                  </button>
                )}
              </div>
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
        <button className={mode === "drank" ? "on" : ""} onClick={() => setMode("drank")}>A băut</button>
        <button className={mode === "dry" ? "on" : ""} onClick={() => setMode("dry")}>Nu a băut</button>
      </div>

      {mode === "drank" ? (
        <div className="counters">
          {DRINKS.map((dk) => (
            <div key={dk.id} className="counter">
              <div className="clabel">
                {dk.label}<small>{dk.serving}</small>
              </div>
              <div className="stepper">
                <button onClick={() => bump(dk.id, -1)} aria-label={`Cu unul mai puțin ${dk.label}`}>−</button>
                <span>{drinks[dk.id] || 0}</span>
                <button onClick={() => bump(dk.id, 1)} aria-label={`Cu unul mai mult ${dk.label}`}>+</button>
              </div>
            </div>
          ))}
          <div className="totline">
            ≈{estimateBAC(total, friend.weight_kg).toFixed(3)}% alcoolemie estimată
            <small className="bacnote">
              Estimare aproximativă presupunând că totul a fost consumat deodată —
              nu e o citire reală, nu te baza pe ea ca să decizi dacă poți conduce.
            </small>
          </div>
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
            placeholder="Sau scrie motivul real"
          />
        </div>
      )}

      <div className="acts">
        <button className="ghost" onClick={onCancel}>Anulează</button>
        {entry && <button className="ghost" onClick={onClear}>Șterge</button>}
        <button
          className="primary"
          onClick={() =>
            onSave(
              mode === "drank"
                ? { drinks, excuse: null }
                : { drinks: {}, excuse: excuse.trim() || "fără motiv" }
            )
          }
        >
          Salvează
        </button>
      </div>
    </div>
  );
}

/* --------------------------- ranking ------------------------------ */

function Ranking({ totals }) {
  const max = Math.max(...totals.map((t) => t.units), 1);
  const any = totals.some((t) => t.units > 0);
  if (!any) return <p className="empty">Nicio băutură înregistrată luna aceasta. Clasamentul se umple pe măsură ce lumea își notează zilele.</p>;

  const peak = totals
    .filter((t) => t.maxDayUnits > 0)
    .map((t) => ({ ...t, bac: estimateBAC(t.maxDayUnits, t.weight_kg) }))
    .sort((a, b) => b.bac - a.bac)[0];

  return (
    <>
      <ol className="board">
        {totals.map((t, i) => (
          <li key={t.id}>
            <div className="brank">{i + 1}</div>
            <div className="bmain">
              <div className="bname">
                <span>{t.name}</span>
                <b>{t.totalDrinks}</b>
              </div>
              <div className="btrack">
                <div style={{ width: `${(t.units / max) * 100}%`, background: t.color }} />
              </div>
              <div className="bmeta">
                {t.days} {t.days === 1 ? "zi de băut" : "zile de băut"} · {t.dry} fără alcool
              </div>
            </div>
          </li>
        ))}
      </ol>

      {peak && (
        <>
          <h3 className="boardhead">Cea mai mare alcoolemie într-o zi luna aceasta</h3>
          <div className="peakcard">
            <span style={{ color: peak.color }}>{peak.name}</span>
            <b>≈{peak.bac.toFixed(3)}%</b>
            <div className="peakdate">
              {Number(peak.maxDayDate.slice(8))} {MONTHS[Number(peak.maxDayDate.slice(5, 7)) - 1]}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* --------------------------- excuses ------------------------------ */

const REACTION_EMOJIS = ["👍", "😊", "😂", "😭", "🍺", "🤡", "🔥", "💀"];

// Plain outline smiley (no color emoji) for the "add a reaction" trigger,
// matching WhatsApp's monochrome reaction icon.
function SmileyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
      <path d="M8 14.5c1 1.4 2.5 2 4 2s3-.6 4-2" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function Excuses({ totals, myFriendId, onDelete }) {
  const all = totals
    .flatMap((t) => t.excuses.map((e) => ({ ...e, name: t.name, color: t.color })))
    .sort((a, b) => a.date.localeCompare(b.date));

  const [reactions, setReactions] = useState({}); // entryId -> [{reactor_friend_id, emoji}]
  const [pickerFor, setPickerFor] = useState(null); // entry id whose picker is open, WhatsApp-style
  const entryIdsKey = all.map((e) => e.id).join(",");

  const reload = useCallback(() => {
    const entryIds = all.map((e) => e.id).filter(Boolean);
    if (!entryIds.length) { setReactions({}); return; }
    fetchReactions(entryIds)
      .then((rows) => {
        const map = {};
        rows.forEach((r) => {
          (map[r.entry_id] ??= []).push(r);
        });
        setReactions(map);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryIdsKey]);

  useEffect(() => { reload(); }, [reload]);

  const toggle = async (entryId, emoji) => {
    if (!myFriendId) return;
    const mine = (reactions[entryId] || []).find((r) => r.reactor_friend_id === myFriendId);
    if (mine && mine.emoji === emoji) {
      await clearReaction(entryId, myFriendId);
    } else {
      await setReaction(entryId, myFriendId, emoji);
    }
    setPickerFor(null);
    reload();
  };

  if (!all.length) return <p className="empty">Nicio zi fără alcool înregistrată încă. Motivele apar aici.</p>;
  return (
    <ul className="exlist">
      {all.map((e) => {
        const entryReactions = reactions[e.id] || [];
        const counts = {};
        entryReactions.forEach((r) => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
        const mine = entryReactions.find((r) => r.reactor_friend_id === myFriendId);
        const canReact = myFriendId && e.friendId !== myFriendId;
        const isMine = myFriendId && e.friendId === myFriendId;
        const pickerOpen = pickerFor === e.id;
        return (
          <li key={e.id}>
            <div className="exday">{Number(e.date.slice(8))}</div>
            <div className="exmain">
              <div className="exwho" style={{ color: e.color }}>{e.name}</div>
              <div className="extext">
                {e.text}
                {canReact && (
                  <button
                    className="addreact"
                    onClick={() => setPickerFor(pickerOpen ? null : e.id)}
                    aria-label="Adaugă o reacție"
                  >
                    <SmileyIcon />
                  </button>
                )}
                {isMine && (
                  <button
                    className="delreact"
                    onClick={() => onDelete(e.friendId, e.date).catch(() => {})}
                    aria-label="Șterge scuza"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
              {Object.keys(counts).length > 0 && (
                <div className="exreactrow">
                  {Object.entries(counts).map(([emoji, count]) => (
                    <span key={emoji} className={mine?.emoji === emoji ? "exreaction mine" : "exreaction"}>
                      {emoji} {count}
                    </span>
                  ))}
                </div>
              )}
              {pickerOpen && (
                <div className="expicker">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      className={mine?.emoji === emoji ? "emojibtn on" : "emojibtn"}
                      onClick={() => toggle(e.id, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------- friends ------------------------------ */

function Friends({ friends, myFriendName, onRemove, onUpdateWeight }) {
  return (
    <div>
      {myFriendName && (
        <p className="legend">Ești conectat ca: <b style={{ color: "var(--amber)" }}>{myFriendName}</b></p>
      )}
      <p className="legend">Setează kilogramele pentru a calcula alcoolemia:</p>
      <ul className="flist">
        {friends.map((f) => (
          <FriendRow key={f.id} friend={f} onRemove={onRemove} onUpdateWeight={onUpdateWeight} />
        ))}
      </ul>
      <p className="legend">
        <button className="ghost sm" style={{ marginLeft: 0 }} onClick={() => supabase.auth.signOut()}>
          Ieși din cont
        </button>
      </p>
    </div>
  );
}

function FriendRow({ friend, onRemove, onUpdateWeight }) {
  const [weight, setWeight] = useState(String(friend.weight_kg ?? 75));
  const [denied, setDenied] = useState(false);

  const commit = async () => {
    const w = Number(weight);
    if (!(w > 0) || w === friend.weight_kg) return;
    try {
      await onUpdateWeight(friend.id, w);
      setDenied(false);
    } catch (err) {
      if (err?.code === "42501") {
        setDenied(true);
        setWeight(String(friend.weight_kg ?? 75));
      } else throw err;
    }
  };

  return (
    <li className="flist-row">
      <div className="flist-main">
        <i className="chip" style={{ background: friend.color }} />
        <span>{friend.name}</span>
        <input
          className="weightinput sm"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          type="number"
          inputMode="numeric"
        />
        <span className="kglabel">kg</span>
        <button className="ghost sm" onClick={() => onRemove(friend.id)}>Elimină</button>
      </div>
      {denied && <p className="denied">{NOT_YOUR_RECORD_MESSAGE}</p>}
    </li>
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
.row{display:flex; align-items:center; gap:6px; width:100%;
  padding:13px 12px; border:1px solid var(--line); border-radius:10px}
.row:hover{border-color:var(--amber)}
.rowmain{display:flex; align-items:center; gap:10px; flex:1; min-width:0; text-align:left}
.rowdel{color:var(--mute); display:inline-flex; padding:4px; flex:none}
.rowdel:hover{color:#D2603A}
.denied{margin:14px 0 0; padding:10px 12px; border:1px solid #D2603A; border-radius:8px;
  background:rgba(210,96,58,.12); color:#D2603A; font-size:13px; font-weight:700;
  text-align:center}
.chip{width:11px; height:11px; border-radius:50%; flex:none; display:block}
.rname{font-weight:600; font-size:15px; flex:none}
.rstate{margin-left:auto; font-size:13px; color:var(--mute);
  min-width:0; flex:1; text-align:right; white-space:normal}
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
.bacnote{display:block; margin-top:4px; font-size:11px; color:var(--mute); font-weight:400}

.chips{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px}
.pill{padding:8px 11px; border:1px solid var(--line); border-radius:999px; font-size:13px; color:var(--mute)}
.pill.on{background:var(--sage); color:var(--ink); border-color:var(--sage); font-weight:600}

.acts{display:flex; gap:8px; margin-top:16px}
.primary{background:var(--amber); color:var(--ink); font-weight:800;
  padding:11px 18px; border-radius:8px; margin-left:auto}
.ghost{padding:11px 14px; border:1px solid var(--line); border-radius:8px;
  font-size:14px; color:var(--mute)}
.ghost.sm{padding:6px 10px; font-size:12px; margin-left:auto}

.boardhead{font-family:Anton, Impact, sans-serif; font-weight:400; font-size:16px;
  text-transform:uppercase; letter-spacing:.02em; color:var(--amber);
  margin:120px 0 16px; padding-top:28px; border-top:1px solid var(--line)}
.peakcard{display:flex; align-items:baseline; flex-wrap:wrap; gap:8px 12px;
  padding:16px; border:1px solid var(--line); border-radius:10px; background:var(--panel)}
.peakcard span{font-weight:700; font-size:16px}
.peakcard b{color:var(--amber); font-size:22px; font-family:Anton, Impact, sans-serif; font-weight:400}
.peakdate{width:100%; font-size:12px; color:var(--mute)}
.board{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:16px}
.board li{display:flex; gap:12px; align-items:flex-start}
.brank{font-family:Anton, Impact, sans-serif; font-size:26px; color:var(--line); min-width:26px}
.board li:first-child .brank{color:var(--amber)}
.bmain{flex:1}
.bname{display:flex; justify-content:space-between; gap:10px; font-size:15px; font-weight:600}
.bname span{flex:none}
.bname b{color:var(--amber); font-weight:800; font-size:14px; text-align:right;
  flex:1; min-width:0; white-space:normal}
.btrack{height:9px; background:var(--panel); border-radius:5px; margin:6px 0 5px; overflow:hidden}
.btrack div{height:100%; border-radius:5px}
.bmeta{font-size:12px; color:var(--mute)}

.exlist{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px}
.exlist li{display:flex; gap:14px; padding:12px 2px; border-bottom:1px solid var(--line)}
.exday{font-family:Anton, Impact, sans-serif; font-size:20px; color:var(--mute); min-width:28px}
.exmain{flex:1; min-width:0}
.exwho{font-size:13px; font-weight:600}
.extext{font-size:15px; margin-top:2px; display:flex; align-items:center; gap:6px}
.exreactrow{display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:8px}
.exreaction{font-size:12px; padding:3px 7px; border-radius:999px; background:var(--panel); border:1px solid var(--line)}
.exreaction.mine{border-color:var(--amber)}
.addreact{color:var(--mute); display:inline-flex; padding:2px}
.addreact:hover{color:var(--amber)}
.delreact{color:var(--mute); display:inline-flex; padding:2px}
.delreact:hover{color:#D2603A}
.expicker{display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; padding:6px; background:var(--panel);
  border:1px solid var(--line); border-radius:10px}
.emojibtn{font-size:17px; padding:4px 7px; border-radius:8px; border:1px solid transparent}
.emojibtn:hover{background:var(--ink); border-color:var(--line)}
.emojibtn.on{background:var(--ink); border-color:var(--amber)}

.tabapp input.weightinput.sm{width:60px; flex:0 0 60px; padding:6px 8px; margin-left:auto; text-align:center}
.kglabel{font-size:12px; color:var(--mute)}
.flist{list-style:none; margin:0; padding:0}
.flist-row{padding:13px 2px; border-bottom:1px solid var(--line); font-size:15px}
.flist-main{display:flex; align-items:center; gap:8px}
.flist-row .denied{margin:10px 0 0}

@media (prefers-reduced-motion: reduce){ .tabapp *{transition:none !important} }
`}</style>
  );
}
