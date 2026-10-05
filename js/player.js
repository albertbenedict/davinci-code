import { db } from "./firebase-config.js";
import {
  ref, onValue, update, onDisconnect, set,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { ROOM_ROOT, applyAction } from "./session.js";
import { sortPlayersByOrder } from "./davinci-logic.js";

const params = new URLSearchParams(location.search);
const code = (params.get("session") || "").trim().toUpperCase();
const playerId = params.get("player");

let room = null;
let busy = false;
// Local guess selection (never stored in Firebase).
let sel = { targetPid: null, tileId: null, value: null, stakeId: null };

if (!code || !playerId || playerId === "undefined") {
  const el = document.getElementById("turn-indicator");
  if (el) {
    el.textContent = "⚠ Missing session – go back and Join again.";
    el.className = "badge badge--danger";
  }
  console.error("player.js missing params", { code, playerId, href: location.href });
} else {
  onValue(ref(db, ".info/connected"), (snap) => {
    if (snap.val() !== true) return;
    const c = ref(db, `${ROOM_ROOT}/${code}/players/${playerId}/connected`);
    onDisconnect(c).set(false).then(() => set(c, true));
  });
  try {
    localStorage.setItem(`dv-player-${code}`, playerId);
  } catch {}

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
    // Self-heal presence (keeps reconnect working mid-game).
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

  const leaveBtn = document.getElementById("leave-btn");
  if (leaveBtn) {
    leaveBtn.addEventListener("click", async () => {
      try {
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

// Clickable face-down tile (opponent guess target, or own stake tile).
function targetTileButton(tile, { selected = false, disabled = false, label = "" } = {}) {
  const btn = document.createElement("button");
  const colorCls = tile.color === "B" ? "tile--black" : "tile--white";
  btn.className = `tile ${colorCls} tile--down tile--target` + (selected ? " tile--target--selected" : "");
  btn.disabled = disabled;
  btn.title = label || (tile.color === "B" ? "Black tile" : "White tile");
  btn.setAttribute("aria-pressed", selected ? "true" : "false");
  const dot = document.createElement("span");
  dot.className = "tile-dot";
  btn.appendChild(dot);
  return btn;
}

function clearSelection() {
  sel = { targetPid: null, tileId: null, value: null, stakeId: null };
}

async function fire(action) {
  if (busy) return;
  busy = true;
  render();
  try {
    await applyAction(code, playerId, action);
    if (action.kind === "guess" || action.kind === "continue") clearSelection();
  } catch (e) {
    console.error("action failed", e);
    alert("Couldn't do that: " + (e.message || e));
  } finally {
    busy = false;
    render();
  }
}

function render() {
  if (!room) return;
  const players = room.players || {};
  const hands = room.hands || {};
  const pile = room.pile || { B: [], W: [] };
  const meta = room.meta || {};
  const ordered = sortPlayersByOrder(players);
  const me = players[playerId];
  const myHand = hands[playerId] || [];
  const myDrawn = (room.drawn || {})[playerId] || null;
  const bLeft = Array.isArray(pile.B) ? pile.B.length : 0;
  const wLeft = Array.isArray(pile.W) ? pile.W.length : 0;

  const myTurn = meta.status === "playing" && meta.currentTurn === playerId && me && !me.eliminated;
  const phase = meta.phase || "draw";
  // Stake mode: both piles empty + no drawn tile → a wrong guess reveals one of my own tiles.
  const stakeMode = !!(myTurn && phase === "guess" && !myDrawn && bLeft + wLeft === 0);

  // Drop stale selections (tile revealed, turn/phase moved on).
  if (sel.targetPid) {
    const th = hands[sel.targetPid] || [];
    const t = th.find((x) => x.id === sel.tileId);
    if (!t || t.revealed || !myTurn || phase !== "guess") {
      sel.targetPid = null; sel.tileId = null; sel.value = null;
    }
  }
  if (!myTurn || phase !== "guess") sel.stakeId = null;

  const badge = document.getElementById("room-badge");
  if (badge) badge.textContent = `Room ${code} · ${meta.status || "lobby"}`;

  // Turn banner
  const banner = document.getElementById("turn-banner");
  const bannerLabel = document.getElementById("turn-banner-label");
  const turnEl = document.getElementById("turn-indicator");
  const currentName = meta.currentTurn && players[meta.currentTurn] ? players[meta.currentTurn].name : null;
  if (banner && bannerLabel && turnEl) {
    if (meta.status === "ended") {
      banner.className = "turn-banner hidden";
    } else if (meta.status === "lobby") {
      banner.className = "turn-banner turn-banner--waiting";
      bannerLabel.textContent = `Lobby — ${ordered.length}/4 players`;
      turnEl.textContent = ordered.length >= 2 ? "Waiting for host to start…" : "Waiting for players…";
      turnEl.className = "turn-banner__sub badge badge--muted";
    } else if (me?.eliminated) {
      banner.className = "turn-banner turn-banner--waiting";
      bannerLabel.textContent = "You are eliminated";
      turnEl.textContent = currentName ? `${currentName}'s turn` : "Waiting…";
      turnEl.className = "turn-banner__sub badge badge--muted";
    } else if (myTurn) {
      banner.className = "turn-banner turn-banner--active";
      bannerLabel.textContent =
        phase === "draw" ? "Your turn — draw a tile!" :
        phase === "guess" ? "Your turn — make a guess!" :
        "Correct! Guess again or stop";
      turnEl.textContent = `Phase: ${phase}`;
      turnEl.className = "turn-banner__sub badge";
    } else {
      banner.className = "turn-banner turn-banner--waiting";
      if (currentName) {
        bannerLabel.innerHTML = `Waiting for <span class="turn-banner__waiting-name">${escapeHtml(currentName)}</span>`;
        turnEl.textContent = `${currentName}'s turn · ${phase}`;
      } else {
        bannerLabel.textContent = "Waiting…";
        turnEl.textContent = "Waiting…";
      }
      turnEl.className = "turn-banner__sub badge badge--muted";
    }
  }

  // My hand — all values visible, revealed marked.
  const handEl = document.getElementById("hand");
  handEl.innerHTML = "";
  if (!myHand.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.fontSize = "0.85rem";
    empty.textContent = meta.status === "lobby" ? "No tiles yet — waiting for host to deal." : "No tiles.";
    handEl.appendChild(empty);
  } else {
    myHand.forEach((t) => {
      if (stakeMode && !t.revealed) {
        const btn = targetTileButton(t, {
          selected: sel.stakeId === t.id,
          disabled: busy,
          label: `Your hidden ${t.color === "B" ? "black" : "white"} ${t.value} — tap to stake it`,
        });
        // Stake tiles show their value to the owner.
        btn.textContent = String(t.value);
        btn.onclick = () => { sel.stakeId = sel.stakeId === t.id ? null : t.id; render(); };
        handEl.appendChild(btn);
      } else {
        handEl.appendChild(tileEl(t, { faceDown: false }));
      }
    });
  }
  const countBadge = document.getElementById("hand-count-badge");
  if (countBadge) {
    countBadge.textContent = myHand.length
      ? `${myHand.length} tiles · ${myHand.filter((t) => t.revealed).length} revealed`
      : "—";
  }

  // Drawn tile (only its owner sees the value — this is your screen).
  const drawnArea = document.getElementById("drawn-area");
  if (drawnArea) {
    drawnArea.innerHTML = "";
    if (myDrawn) {
      drawnArea.classList.remove("hidden");
      const label = document.createElement("div");
      label.className = "muted";
      label.style.fontSize = "0.85rem";
      label.textContent = "You drew:";
      drawnArea.appendChild(label);
      drawnArea.appendChild(tileEl(myDrawn, { faceDown: false }));
    } else {
      drawnArea.classList.add("hidden");
    }
  }

  // Draw buttons.
  const actionsEl = document.getElementById("turn-actions");
  if (actionsEl) {
    actionsEl.innerHTML = "";
    if (myTurn && phase === "draw" && !busy) {
      const row = document.createElement("div");
      row.className = "draw-row";
      if (bLeft + wLeft === 0) {
        const skip = document.createElement("button");
        skip.className = "btn-primary";
        skip.textContent = "Piles empty — guess instead";
        skip.onclick = () => fire({ kind: "draw", color: null });
        row.appendChild(skip);
      } else {
        const bb = document.createElement("button");
        bb.className = "btn-primary";
        bb.textContent = `Draw black (${bLeft} left)`;
        bb.disabled = bLeft === 0 || busy;
        bb.onclick = () => fire({ kind: "draw", color: "B" });
        const wb = document.createElement("button");
        wb.className = "btn-secondary";
        wb.textContent = `Draw white (${wLeft} left)`;
        wb.disabled = wLeft === 0 || busy;
        wb.onclick = () => fire({ kind: "draw", color: "W" });
        row.appendChild(bb);
        row.appendChild(wb);
      }
      actionsEl.appendChild(row);
    } else if (myTurn && phase === "guess" && !sel.targetPid) {
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.style.fontSize = "0.85rem";
      hint.textContent = stakeMode
        ? "Tap one of their face-down tiles — and one of YOUR hidden tiles as stake (piles are empty)."
        : "Tap one of their face-down tiles to guess it.";
      actionsEl.appendChild(hint);
    }
  }

  // Guess box.
  const guessBox = document.getElementById("guess-box");
  if (guessBox) {
    const showBox = !!(myTurn && phase === "guess" && sel.targetPid);
    guessBox.classList.toggle("hidden", !showBox);
    if (showBox) {
      const tName = players[sel.targetPid]?.name || "opponent";
      document.getElementById("guess-target-label").textContent = `${tName} · ${sel.tileId}`;
      const hint = document.getElementById("guess-hint");
      if (hint) {
        hint.textContent = stakeMode && !sel.stakeId
          ? "Piles are empty: also tap one of YOUR hidden tiles as stake (revealed if you're wrong)."
          : "Pick a number 0–11.";
      }
      const grid = document.getElementById("guess-grid");
      grid.innerHTML = "";
      for (let v = 0; v <= 11; v++) {
        const b = document.createElement("button");
        b.textContent = String(v);
        b.className = sel.value === v ? "guess-num guess-num--selected" : "guess-num";
        b.disabled = busy;
        b.setAttribute("aria-pressed", sel.value === v ? "true" : "false");
        b.onclick = ((val) => () => { sel.value = val; render(); })(v);
        grid.appendChild(b);
      }
      const confirm = document.getElementById("guess-confirm");
      const ready = sel.value != null && (!stakeMode || !!sel.stakeId) && !busy;
      confirm.disabled = !ready;
      confirm.onclick = () => fire({
        kind: "guess",
        targetPid: sel.targetPid,
        tileId: sel.tileId,
        value: sel.value,
        ownTileId: sel.stakeId,
      });
      document.getElementById("guess-cancel").onclick = () => { clearSelection(); render(); };
    }
  }

  // Continue row (after a correct guess).
  const contRow = document.getElementById("continue-row");
  if (contRow) {
    const showCont = !!(myTurn && phase === "continue");
    contRow.classList.toggle("hidden", !showCont);
    if (showCont && !contRow.dataset.wired) {
      contRow.dataset.wired = "1";
      document.getElementById("again-btn").onclick = () => fire({ kind: "continue", again: true });
      document.getElementById("stop-btn").onclick = () => fire({ kind: "continue", again: false });
    }
    if (showCont) {
      document.getElementById("again-btn").disabled = busy;
      document.getElementById("stop-btn").disabled = busy;
    }
  }

  // Others — face-down, color only; hidden ones tappable on my guess phase.
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
      label.textContent = p.name + (p.connected === false ? " (offline)" : "") + (p.eliminated ? " (out)" : "");
      if (meta.currentTurn === id && meta.status === "playing") {
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
        h.forEach((t) => {
          if (t.revealed) {
            rack.appendChild(tileEl(t, { faceDown: false }));
          } else {
            const canTap = !!(myTurn && phase === "guess" && !busy);
            const btn = targetTileButton(t, {
              selected: sel.targetPid === id && sel.tileId === t.id,
              disabled: !canTap,
            });
            if (canTap) {
              btn.onclick = () => {
                if (sel.targetPid === id && sel.tileId === t.id) {
                  sel.targetPid = null; sel.tileId = null; sel.value = null;
                } else {
                  sel.targetPid = id; sel.tileId = t.id; sel.value = null;
                }
                render();
              };
            }
            rack.appendChild(btn);
          }
        });
      }
      group.appendChild(rack);
      targetsEl.appendChild(group);
    });
  }

  // Pile counts
  const pileInfo = document.getElementById("pile-info");
  if (pileInfo) {
    pileInfo.textContent = meta.status === "lobby"
      ? "Pile: not dealt yet (24 tiles: B 0–11, W 0–11)"
      : `Pile remaining: B ${bLeft} · W ${wLeft} (${bLeft + wLeft} left)`;
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
