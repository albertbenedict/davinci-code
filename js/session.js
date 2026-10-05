import { db } from "./firebase-config.js";
import {
  ref, set, get, onValue, update, onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { buildPiles, dealHands, tilesPerPlayerForCount, sortPlayersByOrder } from "./davinci-logic.js";

export const ROOM_ROOT = "davinciRooms";

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — Firebase is unreachable. Disable Firefox Enhanced Tracking Protection (shield icon) and check Wi-Fi.`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

function generateCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function randomId(prefix) {
  return `${prefix}_` + Math.random().toString(36).slice(2, 9);
}

export async function createRoom() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const existsSnap = await withTimeout(get(ref(db, `${ROOM_ROOT}/${code}/meta`)), 8000, "Checking room code");
    if (existsSnap.exists()) continue;
    const hostId = randomId("t");
    await withTimeout(set(ref(db, `${ROOM_ROOT}/${code}`), {
      meta: {
        hostId,
        status: "lobby",
        currentTurn: null,
        phase: "draw",
        winner: null,
        createdAt: Date.now(),
      },
      players: {},
      hands: {},
      pile: { B: [], W: [] },
      drawn: {},
    }), 8000, "Creating room");
    try { localStorage.setItem(`dv-table-${code}`, hostId); } catch {}
    return code;
  }
  throw new Error("Failed to generate unique room code – please retry");
}

export async function joinRoom(code, playerName, storedId = null) {
  code = String(code || "").trim().toUpperCase();
  const nameTrim = String(playerName || "").trim();
  if (!code) throw new Error("Missing room code");
  if (!nameTrim) throw new Error("Missing player name");

  const roomSnap = await withTimeout(get(ref(db, `${ROOM_ROOT}/${code}`)), 8000, "Checking room");
  const room = roomSnap.val();
  if (!room || !room.meta) throw new Error(`Room "${code}" not found`);
  const players = room.players || {};

  // 1) Reconnect via stored device ID (localStorage).
  if (storedId && players[storedId]) {
    await withTimeout(update(ref(db, `${ROOM_ROOT}/${code}/players/${storedId}`), {
      name: nameTrim,
      connected: true,
    }), 5000, "Reconnecting");
    try { onDisconnect(ref(db, `${ROOM_ROOT}/${code}/players/${storedId}/connected`)).set(false); } catch {}
    try {
      localStorage.setItem(`dv-player-${code}`, storedId);
      localStorage.setItem(`dv-name-${code}`, nameTrim);
    } catch {}
    return storedId;
  }

  // 2) Reconnect via offline name match (new device / cleared storage).
  try {
    const nameLower = nameTrim.toLowerCase();
    const offlineMatch = Object.entries(players).find(
      ([, p]) => p && p.name && p.name.trim().toLowerCase() === nameLower && p.connected === false
    );
    if (offlineMatch) {
      const [offlineId] = offlineMatch;
      await withTimeout(update(ref(db, `${ROOM_ROOT}/${code}/players/${offlineId}`), {
        name: nameTrim,
        connected: true,
      }), 5000, "Reconnecting offline");
      try { onDisconnect(ref(db, `${ROOM_ROOT}/${code}/players/${offlineId}/connected`)).set(false); } catch {}
      try {
        localStorage.setItem(`dv-player-${code}`, offlineId);
        localStorage.setItem(`dv-name-${code}`, nameTrim);
      } catch {}
      return offlineId;
    }
  } catch (e) {
    console.warn("offline name check failed", e);
  }

  // 3) Fresh join — lobby only, 2-4 players.
  if (room.meta.status !== "lobby") throw new Error("Game already started — ask host to reset to lobby");
  if (Object.keys(players).length >= 4) throw new Error("Room is full (max 4 players)");

  const playerId = randomId("p");
  const maxOrder = Object.values(players).reduce((m, p) => Math.max(m, p.order ?? -1), -1);
  await withTimeout(set(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}`), {
    name: nameTrim,
    order: maxOrder + 1,
    connected: true,
    eliminated: false,
  }), 8000, "Joining room");
  try { onDisconnect(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}/connected`)).set(false); } catch {}
  try {
    localStorage.setItem(`dv-player-${code}`, playerId);
    localStorage.setItem(`dv-name-${code}`, nameTrim);
  } catch {}
  return playerId;
}

export function watchRoom(code, callback) {
  if (!code || typeof code !== "string" || code.trim().length === 0) {
    console.warn("watchRoom called with empty code:", code);
    setTimeout(() => callback(null), 0);
    return () => {};
  }
  return onValue(ref(db, `${ROOM_ROOT}/${code}`), (snapshot) => {
    callback(snapshot.val());
  }, (err) => {
    console.error("watchRoom error", code, err);
    callback(null);
  });
}

export async function roomExists(code) {
  if (!code) return false;
  try {
    const snap = await withTimeout(get(ref(db, `${ROOM_ROOT}/${code}/meta`)), 8000, "Checking room");
    return snap.exists();
  } catch (e) {
    console.error("roomExists failed", e);
    throw e;
  }
}

export async function getRoom(code) {
  const snap = await withTimeout(get(ref(db, `${ROOM_ROOT}/${code}`)), 8000, "Loading room");
  return snap.val();
}

// Host: deal + start. Multi-path update — touches meta, hands, pile, drawn, players.
export async function startGame(code) {
  const room = await getRoom(code);
  if (!room || !room.meta) throw new Error("Room not found");
  const players = room.players || {};
  const ids = sortPlayersByOrder(players).map(([id]) => id);
  if (ids.length < 2 || ids.length > 4) throw new Error(`Need 2-4 players to start (have ${ids.length})`);
  if (room.meta.status === "playing") throw new Error("Game already started");

  const perPlayer = tilesPerPlayerForCount(ids.length);
  const piles = buildPiles();
  const { hands, pile } = dealHands(piles.B, piles.W, ids, perPlayer);

  const updates = {};
  updates["meta/status"] = "playing";
  updates["meta/currentTurn"] = ids[0];
  updates["meta/phase"] = "draw";
  updates["meta/winner"] = null;
  updates["meta/playerCount"] = ids.length;
  updates["meta/tilesPerPlayer"] = perPlayer;
  updates["hands"] = hands;
  updates["pile"] = pile;
  updates["drawn"] = {};
  ids.forEach((id) => {
    updates[`players/${id}/eliminated`] = false;
    updates[`players/${id}/connected`] = players[id]?.connected ?? true;
  });

  await withTimeout(update(ref(db, `${ROOM_ROOT}/${code}`), updates), 8000, "Dealing tiles");
}

// Host: kick a player. Multi-path update.
export async function kickPlayer(code, playerId) {
  const room = await getRoom(code);
  if (!room) return;
  const players = room.players || {};
  if (!players[playerId]) return;
  const updates = {};
  updates[`players/${playerId}`] = null;
  updates[`hands/${playerId}`] = null;
  updates[`drawn/${playerId}`] = null;

  const remaining = sortPlayersByOrder(players)
    .map(([id]) => id)
    .filter((id) => id !== playerId);

  if (room.meta?.currentTurn === playerId) {
    updates["meta/currentTurn"] = remaining.length ? remaining[0] : null;
  }
  if (remaining.length < 2 && room.meta?.status === "playing") {
    updates["meta/status"] = "lobby";
    updates["meta/currentTurn"] = null;
    updates["meta/winner"] = null;
  }
  await withTimeout(update(ref(db, `${ROOM_ROOT}/${code}`), updates), 8000, "Kicking player");
}

// Host: reset to lobby, keep players. Multi-path update.
export async function resetRoom(code) {
  const room = await getRoom(code);
  if (!room) return;
  const updates = {
    "meta/status": "lobby",
    "meta/currentTurn": null,
    "meta/phase": "draw",
    "meta/winner": null,
    hands: {},
    pile: { B: [], W: [] },
    drawn: {},
  };
  Object.keys(room.players || {}).forEach((id) => {
    updates[`players/${id}/eliminated`] = false;
  });
  await withTimeout(update(ref(db, `${ROOM_ROOT}/${code}`), updates), 8000, "Resetting room");
}

// Host: delete room for everyone.
export async function endRoom(code) {
  await withTimeout(set(ref(db, `${ROOM_ROOT}/${code}`), null), 8000, "Ending room");
}
