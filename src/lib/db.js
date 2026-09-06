import { supabase } from "./supabaseClient";

const DRINK_COLUMNS = ["beer", "beer_small", "wine", "rum", "whisky", "vodka"];

// RLS rejecting an UPDATE/DELETE matches zero rows instead of erroring —
// callers check .code === "42501" the same way as a real Postgres error.
const RLS_DENIED = { code: "42501", message: "row-level security rejected the write" };

export async function fetchFriends() {
  const { data, error } = await supabase
    .from("friends")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addFriend(name, color, weightKg) {
  const { data, error } = await supabase
    .from("friends")
    .insert({ name, color, weight_kg: weightKg })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeFriend(id) {
  const { error } = await supabase.from("friends").delete().eq("id", id);
  if (error) throw error;
}

export async function updateFriendWeight(id, weightKg) {
  const { data, error } = await supabase
    .from("friends")
    .update({ weight_kg: weightKg })
    .eq("id", id)
    .select();
  if (error) throw error;
  if (!data || data.length === 0) throw RLS_DENIED;
}

export async function fetchEntries(monthStart, monthEnd) {
  const { data, error } = await supabase
    .from("entries")
    .select("*")
    .gte("day", monthStart)
    .lte("day", monthEnd);
  if (error) throw error;
  return data;
}

export async function saveEntry(friendId, day, { drinks, excuse }) {
  const row = { friend_id: friendId, day, excuse: excuse || null };
  DRINK_COLUMNS.forEach((id) => {
    row[id] = drinks?.[id] || 0;
  });
  const { data, error } = await supabase
    .from("entries")
    .upsert(row, { onConflict: "friend_id,day" })
    .select();
  if (error) throw error;
  // Updating (not inserting) a row RLS rejects matches zero rows instead
  // of erroring — treat that the same as a rejected write.
  if (!data || data.length === 0) throw RLS_DENIED;
}

export async function deleteEntry(friendId, day) {
  const { data, error } = await supabase
    .from("entries")
    .delete()
    .match({ friend_id: friendId, day })
    .select();
  if (error) throw error;
  if (data && data.length > 0) return;
  // Zero rows affected is ambiguous: it means either the row belongs to
  // someone else (RLS filtered it out) or it's already gone (nothing to
  // delete — not an error). The read policy is open to everyone, so a
  // plain select disambiguates: if it's still visible, it was denied.
  const { data: existing } = await supabase
    .from("entries")
    .select("id")
    .match({ friend_id: friendId, day })
    .maybeSingle();
  if (existing) throw RLS_DENIED;
}

// DB row (flat drink columns) -> UI shape ({ id, drinks: {...}, excuse })
export function rowToEntry(row) {
  const drinks = {};
  DRINK_COLUMNS.forEach((id) => {
    if (row[id]) drinks[id] = row[id];
  });
  return { id: row.id, drinks, excuse: row.excuse };
}

// [{friend_id, day, ...}] -> { [day]: { [friend_id]: {drinks, excuse} } }
export function rowsToEntriesMap(rows) {
  const map = {};
  rows.forEach((row) => {
    if (!map[row.day]) map[row.day] = {};
    map[row.day][row.friend_id] = rowToEntry(row);
  });
  return map;
}

export async function fetchReactions(entryIds) {
  if (!entryIds.length) return [];
  const { data, error } = await supabase
    .from("excuse_reactions")
    .select("*")
    .in("entry_id", entryIds);
  if (error) throw error;
  return data;
}

// One reaction per (entry, reactor) — picking a new emoji replaces the old one.
export async function setReaction(entryId, reactorFriendId, emoji) {
  const { error } = await supabase
    .from("excuse_reactions")
    .upsert(
      { entry_id: entryId, reactor_friend_id: reactorFriendId, emoji },
      { onConflict: "entry_id,reactor_friend_id" }
    );
  if (error) throw error;
}

export async function clearReaction(entryId, reactorFriendId) {
  const { error } = await supabase
    .from("excuse_reactions")
    .delete()
    .match({ entry_id: entryId, reactor_friend_id: reactorFriendId });
  if (error) throw error;
}
