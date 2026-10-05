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
