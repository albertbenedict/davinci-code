// Da Vinci Code core logic — pure functions, no Firebase imports.
// Tile: { id, color: "B"|"W", value: 0-11, revealed: boolean }

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function tileComparator(a, b) {
  if (a.value !== b.value) return a.value - b.value;
  // Same value: black before white.
  if (a.color === b.color) return 0;
  return a.color === "B" ? -1 : 1;
}

export function sortHand(hand) {
  hand.sort(tileComparator);
  return hand;
}

// Reusable sorted insert — keeps hand ascending by value, B before W on ties.
export function insertSorted(hand, tile) {
  let idx = hand.findIndex((t) => tileComparator(tile, t) < 0);
  if (idx === -1) idx = hand.length;
  hand.splice(idx, 0, tile);
  return hand;
}

// Generate 24 tiles (0-11 in black and white), split into two shuffled piles.
export function buildPiles() {
  const pileB = [];
  const pileW = [];
  for (let v = 0; v <= 11; v++) {
    pileB.push({ id: `B${v}`, color: "B", value: v, revealed: false });
    pileW.push({ id: `W${v}`, color: "W", value: v, revealed: false });
  }
  return { B: shuffle(pileB), W: shuffle(pileW) };
}

export function tilesPerPlayerForCount(n) {
  if (n === 4) return 3;
  return 4; // 2-3 players
}

// Deal from either pile (random mix). Returns { hands, pile }.
// Does not mutate inputs — works on shuffled copies.
export function dealHands(pileB, pileW, playerIds, tilesPerPlayer) {
  const b = [...pileB];
  const w = [...pileW];
  const hands = {};
  playerIds.forEach((id) => (hands[id] = []));

  for (let r = 0; r < tilesPerPlayer; r++) {
    for (const pid of playerIds) {
      const useBlack =
        b.length === 0 ? false : w.length === 0 ? true : Math.random() < 0.5;
      const tile = useBlack ? b.pop() : w.pop();
      if (!tile) throw new Error("Not enough tiles to deal");
      // hands are built in random draw order — insert sorted.
      insertSorted(hands[pid], { ...tile, revealed: false });
    }
  }
  return { hands, pile: { B: b, W: w } };
}

// Order helpers
export function sortPlayersByOrder(players) {
  return Object.entries(players || {}).sort(
    (a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)
  );
}

export function nextTurnAfter(currentPid, players) {
  const ordered = sortPlayersByOrder(players)
    .filter(([, p]) => !p.eliminated)
    .map(([id]) => id);
  if (!ordered.length) return null;
  const idx = ordered.indexOf(currentPid);
  if (idx === -1) return ordered[0];
  return ordered[(idx + 1) % ordered.length];
}

// Next non-eliminated player after fromPid in join order (wraps around).
// Unlike nextTurnAfter, this works even when fromPid is eliminated/missing.
export function advanceFrom(players, fromPid) {
  const ordered = sortPlayersByOrder(players).map(([id]) => id);
  if (!ordered.length) return null;
  const idx = ordered.indexOf(fromPid);
  for (let step = 1; step <= ordered.length; step++) {
    const cand = ordered[(idx + step) % ordered.length];
    if (!players[cand]?.eliminated) return cand;
  }
  return null;
}

// Mark every player with zero hidden tiles as eliminated.
// Hidden = unrevealed hand tiles + held drawn tile. Returns alive ids.
export function recomputeElimination(room) {
  const players = room.players || {};
  const hands = room.hands || {};
  const drawn = room.drawn || {};
  for (const [pid, p] of Object.entries(players)) {
    const hand = hands[pid];
    if (!Array.isArray(hand)) continue;
    const hidden = hand.filter((t) => !t.revealed).length + (drawn[pid] ? 1 : 0);
    p.eliminated = hidden === 0 && hand.length > 0;
  }
  return Object.entries(players)
    .filter(([, p]) => !p.eliminated)
    .map(([id]) => id);
}

function checkWin(room) {
  const alive = recomputeElimination(room);
  if (alive.length <= 1) {
    room.meta.status = "ended";
    room.meta.winner = alive[0] || null;
    room.meta.currentTurn = room.meta.winner;
    room.meta.phase = "draw";
  }
  return alive;
}

// Pure room transition for the turn loop (draw -> guess -> continue/stop).
// Mutates `room` (a clone) on success. Returns { ok:true } or { ok:false, error }.
// Action kinds:
//   { kind:"draw", color:"B"|"W"|null }          — null skips when piles are empty
//   { kind:"guess", targetPid, tileId, value, ownTileId? }
//   { kind:"continue", again:true|false }
export function applyActionToRoom(room, playerId, action) {
  if (!room || !room.meta) return { ok: false, error: "Room not found" };
  const meta = room.meta;
  if (meta.status !== "playing") return { ok: false, error: "Game is not in progress" };
  const players = room.players || {};
  const me = players[playerId];
  if (!me) return { ok: false, error: "You are not in this room" };
  if (me.eliminated) return { ok: false, error: "You are eliminated" };
  if (meta.currentTurn !== playerId) return { ok: false, error: "Not your turn" };
  room.hands = room.hands || {};
  room.pile = room.pile || { B: [], W: [] };
  if (!Array.isArray(room.pile.B)) room.pile.B = [];
  if (!Array.isArray(room.pile.W)) room.pile.W = [];
  room.drawn = room.drawn || {};
  const ts = Date.now();

  if (action.kind === "draw") {
    if (meta.phase !== "draw") return { ok: false, error: "Draw phase is over" };
    if (room.drawn[playerId]) return { ok: false, error: "You already drew a tile" };
    const bLeft = room.pile.B.length;
    const wLeft = room.pile.W.length;
    if (bLeft + wLeft === 0) {
      // Both piles empty — skip draw, go straight to guessing.
      meta.phase = "guess";
      room.lastAction = { type: "draw", by: playerId, skipped: true, ts };
      return { ok: true };
    }
    const color = action.color;
    if (color !== "B" && color !== "W") return { ok: false, error: "Pick black or white" };
    if (room.pile[color].length === 0) {
      return { ok: false, error: `No ${color === "B" ? "black" : "white"} tiles left — pick the other pile` };
    }
    const tile = room.pile[color].pop();
    room.drawn[playerId] = { ...tile, revealed: false };
    meta.drawnColor = color;
    meta.phase = "guess";
    room.lastAction = { type: "draw", by: playerId, target: null, color, ts };
    checkWin(room);
    return { ok: true };
  }

  if (action.kind === "guess") {
    if (meta.phase !== "guess") return { ok: false, error: "Guess phase is not active" };
    const { targetPid, tileId, value } = action;
    if (!targetPid || targetPid === playerId) return { ok: false, error: "Pick an opponent's tile" };
    const target = players[targetPid];
    if (!target) return { ok: false, error: "Target player not found" };
    if (target.eliminated) return { ok: false, error: "That player is eliminated" };
    const targetHand = room.hands[targetPid] || [];
    const tile = targetHand.find((t) => t.id === tileId);
    if (!tile) return { ok: false, error: "Tile not found" };
    if (tile.revealed) return { ok: false, error: "That tile is already revealed" };
    const guessVal = Number(value);
    if (!Number.isInteger(guessVal) || guessVal < 0 || guessVal > 11) {
      return { ok: false, error: "Pick a number 0–11" };
    }
    if (guessVal === tile.value) {
      tile.revealed = true;
      meta.phase = "continue";
      room.lastAction = { type: "guess", by: playerId, target: targetPid, tileId, value: guessVal, correct: true, ts };
      checkWin(room);
      return { ok: true };
    }
    // Wrong guess — the drawn tile goes into the guesser's row revealed.
    const drawnTile = room.drawn[playerId];
    if (drawnTile) {
      insertSorted(room.hands[playerId] || (room.hands[playerId] = []), { ...drawnTile, revealed: true });
      delete room.drawn[playerId];
    } else {
      // No drawn tile (piles were empty) — reveal one of your own hidden tiles instead.
      const ownHand = room.hands[playerId] || [];
      const stake = ownHand.find((t) => t.id === action.ownTileId && !t.revealed);
      if (!stake) return { ok: false, error: "Wrong! No drawn tile — tap one of your hidden tiles to reveal" };
      stake.revealed = true;
    }
    meta.drawnColor = null;
    room.lastAction = { type: "guess", by: playerId, target: targetPid, tileId, value: guessVal, correct: false, ts };
    checkWin(room);
    if (room.meta.status === "playing") {
      meta.currentTurn = advanceFrom(players, playerId);
      meta.phase = "draw";
    }
    return { ok: true };
  }

  if (action.kind === "continue") {
    if (meta.phase !== "continue") return { ok: false, error: "Nothing to continue" };
    if (action.again === true) {
      meta.phase = "guess";
      room.lastAction = { type: "continue", by: playerId, again: true, ts };
      return { ok: true };
    }
    // Stop — place the drawn tile face-down, pass the turn.
    const drawnTile = room.drawn[playerId];
    if (drawnTile) {
      insertSorted(room.hands[playerId] || (room.hands[playerId] = []), { ...drawnTile, revealed: false });
      delete room.drawn[playerId];
    }
    meta.drawnColor = null;
    room.lastAction = { type: "continue", by: playerId, again: false, ts };
    checkWin(room);
    if (room.meta.status === "playing") {
      meta.currentTurn = advanceFrom(players, playerId);
      meta.phase = "draw";
    }
    return { ok: true };
  }

  return { ok: false, error: "Unknown action" };
}
