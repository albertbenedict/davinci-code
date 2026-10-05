import { db } from "./firebase-config.js";
import {
  ref, onValue, update, onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { ROOM_ROOT } from "./session.js";
import { sortPlayersByOrder } from "./davinci-logic.js";

const params = new URLSearchParams(location.search);
const code = (params.get("session") || "").trim().toUpperCase();
const playerId = params.get("player");

let room = null;
let disconnectRef = null;

if (!code || !playerId || playerId === "undefined") {
  const el = document.getElementById("turn-indicator");
  if (el) {
    el.textContent = "⚠ Missing session – go back and Join again.";
    el.className = "badge badge--danger";
  }
  console.error("player.js missing params", { code, playerId, href: location.href });
} else {
  try {
    update(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}`), { connected: true }).catch(() => {});
    disconnectRef = onDisconnect(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}/connected`));
    disconnectRef.set(false).catch(() => {});
    try {
      localStorage.setItem(`dv-player-${code}`, playerId);
      const nm = room?.players?.[playerId]?.name;
      if (nm) localStorage.setItem(`dv-name-${code}`, nm);
    } catch {}
  } catch (e) { console.warn("presence failed", e); }

  onValue(ref(db, `${ROOM_ROOT}/${code}`), (snap) => {
    room = snap.val();
    if (!room) {
      const el = document.getElementById("turn-indicator");
      if (el) {
        el.textContent = `⚠ No room "${code}" – did it end or was Firebase blocked?`;
        el.className = "badge badge--danger";
      }
      console.warn("player: no room", code);
      return;
    }
    // Self-heal presence.
    if (room.players?.[playerId]?.connected === false) {
      try { update(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}`), { connected: true }); } catch {}
    }
    try {
      const myName = room.players?.[playerId]?.name;
      if (myName) localStorage.setItem(`dv-name-${code}`, myName);
    } catch {}
    render();
  }, (err) => {
    console.error("player onValue error", err);
    const el = document.getElementById("turn-indicator");
    if (el) {
      el.textContent = "⚠ Connection failed – check Wi-Fi / disable Firefox shield.";
      el.className = "badge badge--danger";
    }
  });

  window.addEventListener("beforeunload", () => {
    try {
      if (disconnectRef) disconnectRef.cancel();
      update(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}`), { connected: false });
    } catch {}
  });
  const leaveBtn = document.getElementById("leave-btn");
  if (leaveBtn) {
    leaveBtn.addEventListener("click", async () => {
      try {
        if (disconnectRef) await disconnectRef.cancel().catch(() => {});
        await update(ref(db, `${ROOM_ROOT}/${code}/players/${playerId}`), { connected: false });
      } catch {}
      try { localStorage.removeItem(`dv-player-${code}`); } catch {}
      location.href = "index.html";
    });
  }
}

function tileEl(tile, { faceDown = false } = {}) {
  const div = document.createElement("div");
  const colorCls = tile.color === "B" ? "tile--black" : "tile--white";
  if (faceDown) {
    div.className = `tile ${colorCls} tile--down`;
    div.title = tile.color === "B" ? "Black tile" : "White tile";
    // Color only — no number.
    const dot = document.createElement("span");
    dot.className = "tile-dot";
    div.appendChild(dot);
  } else {
    div.className = `tile ${colorCls}` + (tile.revealed ? " tile--revealed" : "");
    div.textContent = String(tile.value);
    div.title = `${tile.color === "B" ? "Black" : "White"} ${tile.value}${tile.revealed ? " (revealed)" : ""}`;
    if (tile.revealed) {
      const mark = document.createElement("span");
      mark.className = "tile-revealed-mark";
      mark.textContent = "✓";
      mark.title = "Revealed";
      div.appendChild(mark);
    }
  }
  return div;
}

function render() {
  if (!room) return;
  const players = room.players || {};
  const hands = room.hands || {};
  const pile = room.pile || { B: [], W: [] };
  const meta = room.meta || {};
  const ordered = sortPlayersByOrder(players);

  const badge = document.getElementById("room-badge");
  if (badge) badge.textContent = `Room ${code} · ${meta.status || "lobby"}`;

  // Turn banner
  const banner = document.getElementById("turn-banner");
  const bannerLabel = document.getElementById("turn-banner-label");
  const turnEl = document.getElementById("turn-indicator");
  const currentName = meta.currentTurn && players[meta.currentTurn] ? players[meta.currentTurn].name : null;
  const myTurn = meta.status === "playing" && meta.currentTurn === playerId;
  if (banner && bannerLabel && turnEl) {
    if (meta.status === "ended") {
      banner.className = "turn-banner hidden";
    } else if (meta.status === "lobby") {
      banner.className = "turn-banner turn-banner--waiting";
      bannerLabel.textContent = `Lobby — ${ordered.length}/4 players`;
      turnEl.textContent = ordered.length >= 2 ? "Waiting for host to start…" : "Waiting for players…";
      turnEl.className = "turn-banner__sub badge badge--muted";
    } else if (myTurn) {
      banner.className = "turn-banner turn-banner--active";
      bannerLabel.textContent = "Your turn — go!";
      turnEl.textContent = `Phase: ${meta.phase || "draw"} (actions next chunk)`;
      turnEl.className = "turn-banner__sub badge";
    } else {
      banner.className = "turn-banner turn-banner--waiting";
      if (currentName) {
        bannerLabel.innerHTML = `Waiting for <span class="turn-banner__waiting-name">${escapeHtml(currentName)}</span>`;
        turnEl.textContent = `${currentName}'s turn · ${meta.phase || ""}`;
      } else {
        bannerLabel.textContent = "Waiting…";
        turnEl.textContent = "Waiting…";
      }
      turnEl.className = "turn-banner__sub badge badge--muted";
    }
  }

  // My hand — all values visible, revealed marked.
  const myHand = hands[playerId] || [];
  const handEl = document.getElementById("hand");
  handEl.innerHTML = "";
  if (!myHand.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.fontSize = "0.85rem";
    empty.textContent = meta.status === "lobby" ? "No tiles yet — waiting for host to deal." : "No tiles.";
    handEl.appendChild(empty);
  } else {
    myHand.forEach((t) => handEl.appendChild(tileEl(t, { faceDown: false })));
  }
  const countBadge = document.getElementById("hand-count-badge");
  if (countBadge) {
    countBadge.textContent = myHand.length
      ? `${myHand.length} tiles · ${myHand.filter((t) => t.revealed).length} revealed`
      : "—";
  }

  // Drawn tile this turn (not yet placed) — reserved for next chunk.
  const drawnArea = document.getElementById("drawn-area");
  const myDrawn = (room.drawn || {})[playerId];
  if (drawnArea) {
    drawnArea.innerHTML = "";
    if (myDrawn) {
      drawnArea.classList.remove("hidden");
      const label = document.createElement("div");
      label.className = "muted";
      label.style.fontSize = "0.85rem";
      label.textContent = "Drawn (not yet placed):";
      drawnArea.appendChild(label);
      drawnArea.appendChild(tileEl(myDrawn, { faceDown: false }));
    } else {
      drawnArea.classList.add("hidden");
    }
  }

  // Others — face-down, color only.
  const targetsEl = document.getElementById("targets");
  targetsEl.innerHTML = "";
  const others = ordered.filter(([id]) => id !== playerId);
  if (!others.length) {
    targetsEl.innerHTML = `<div class="muted" style="font-size:0.85rem;">No other players yet.</div>`;
  } else {
    others.forEach(([id, p]) => {
      const group = document.createElement("div");
      group.className = "player-group";
      const head = document.createElement("div");
      head.className = "player-group__head";
      const label = document.createElement("div");
      label.className = "player-group__name";
      label.textContent = p.name + (p.connected === false ? " (offline)" : "");
      if (meta.currentTurn === id) {
        const b = document.createElement("span");
        b.className = "badge";
        b.style.marginLeft = "0.4rem";
        b.textContent = "Turn";
        label.appendChild(b);
      }
      head.appendChild(label);
      const meta2 = document.createElement("span");
      meta2.className = "badge badge--muted";
      meta2.style.fontSize = "0.62rem";
      const h = hands[id] || [];
      meta2.textContent = `${h.length} tiles`;
      head.appendChild(meta2);
      group.appendChild(head);

      const rack = document.createElement("div");
      rack.className = "rack";
      if (!h.length) {
        rack.innerHTML = `<span class="muted" style="font-size:0.8rem;">No tiles yet</span>`;
      } else {
        h.forEach((t) => rack.appendChild(tileEl(t, { faceDown: true })));
      }
      group.appendChild(rack);
      targetsEl.appendChild(group);
    });
  }

  // Pile counts
  const pileInfo = document.getElementById("pile-info");
  if (pileInfo) {
    const b = Array.isArray(pile.B) ? pile.B.length : 0;
    const w = Array.isArray(pile.W) ? pile.W.length : 0;
    pileInfo.textContent = meta.status === "lobby"
      ? "Pile: not dealt yet (24 tiles: B 0–11, W 0–11)"
      : `Pile remaining: B ${b} · W ${w} (${b + w} left)`;
  }

  const statusEl = document.getElementById("status");
  if (statusEl) {
    if (meta.status === "ended") {
      const wname = meta.winner && players[meta.winner] ? players[meta.winner].name : "—";
      statusEl.textContent = `Game over — winner: ${wname}`;
      statusEl.className = "banner banner--success";
    } else if (meta.status === "lobby") {
      statusEl.textContent = `Lobby: ${ordered.length} player${ordered.length === 1 ? "" : "s"} — need 2–4 to start.`;
      statusEl.className = "banner hidden";
      statusEl.classList.remove("hidden");
      statusEl.style.fontSize = "0.9rem";
      statusEl.style.fontWeight = "500";
      statusEl.style.padding = "0.8rem";
    } else {
      statusEl.className = "banner hidden";
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
