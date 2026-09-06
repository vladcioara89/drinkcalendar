import { supabase } from "./supabaseClient";

const DRINK_COLUMNS = ["beer", "beer_small", "wine", "rum", "whisky", "vodka"];

export async function fetchFriends() {
  const { data, error } = await supabase
    .from("friends")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addFriend(name, color) {
  const { data, error } = await supabase
    .from("friends")
    .insert({ name, color })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeFriend(id) {
  const { error } = await supabase.from("friends").delete().eq("id", id);
  if (error) throw error;
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
  const { error } = await supabase
    .from("entries")
    .upsert(row, { onConflict: "friend_id,day" });
  if (error) throw error;
}

export async function deleteEntry(friendId, day) {
  const { error } = await supabase
    .from("entries")
    .delete()
    .match({ friend_id: friendId, day });
  if (error) throw error;
}

// DB row (flat drink columns) -> UI shape ({ drinks: {...}, excuse })
export function rowToEntry(row) {
  const drinks = {};
  DRINK_COLUMNS.forEach((id) => {
    if (row[id]) drinks[id] = row[id];
  });
  return { drinks, excuse: row.excuse };
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
