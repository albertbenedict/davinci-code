import { db } from "./firebase-config.js";
import {
  ref, onValue,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { watchRoom, startGame, kickPlayer, resetRoom, endRoom, isHost } from "./session.js";
import { sortPlayersByOrder } from "./davinci-logic.js";

const params = new URLSearchParams(location.search);
const code = (params.get("session") || "").trim().toUpperCase();
const roomCodeEl = document.getElementById("room-code");
const tableErrorEl = document.getElementById("table-error");
const tableConnDot = document.getElementById("table-conn-dot");
const tableConnText = document.getElementById("table-conn-text");
const host = isHost(code);
let winDismissed = false;

function setTableConn(connected) {
  if (!tableConnDot || !tableConnText) return;
  tableConnDot.style.background = connected ? "#1a9e32" : "#c81e2c";
  tableConnDot.style.boxShadow = connected ? "0 0 0 4px #d1f0d7" : "0 0 0 4px #fdeceb";
  tableConnText.textContent = connected ? "Connected" : "Offline — check Wi-Fi / disable Firefox Tracking Protection";
}

function showTableError(message, hint) {
  tableErrorEl.innerHTML = "";
  const strong = document.createElement("div");
  strong.textContent = message;
  strong.style.fontWeight = "700";
  tableErrorEl.appendChild(strong);
  if (hint) {
    const small = document.createElement("div");
    small.textContent = hint;
    small.style.fontWeight = "400";
    small.style.fontSize = "0.82rem";
    small.style.opacity = "0.9";
    small.style.marginTop = "0.35rem";
    tableErrorEl.appendChild(small);
  }
  const actions = document.createElement("div");
  actions.style.marginTop = "0.75rem";
  actions.style.display = "flex";
  actions.style.gap = "0.5rem";
  actions.style.justifyContent = "center";
  actions.style.flexWrap = "wrap";
  const backBtn = document.createElement("button");
  backBtn.textContent = "← Back to lobby";
  backBtn.className = "btn-secondary";
  backBtn.style.padding = "0.5rem 1rem";
  backBtn.style.fontSize = "0.9rem";
  backBtn.onclick = () => location.href = "index.html";
  actions.appendChild(backBtn);
  if (code) {
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Retry";
    retryBtn.className = "btn-primary";
    retryBtn.style.padding = "0.5rem 1rem";
    retryBtn.style.fontSize = "0.9rem";
    retryBtn.onclick = () => location.reload();
    actions.appendChild(retryBtn);
  }
  tableErrorEl.appendChild(actions);
  tableErrorEl.classList.remove("hidden");
}

const shareBtn = document.getElementById("share-link-btn");
if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const c = roomCodeEl.textContent?.trim();
    if (!c || c === "—" || c === "----") return;
    const url = `${location.origin}${location.pathname.replace(/table\.html$/, "index.html")}?join=${c}`;
    try {
      await navigator.clipboard.writeText(url);
      shareBtn.textContent = "✓ Link copied";
      setTimeout(() => { shareBtn.textContent = "↗ Share"; }, 1600);
    } catch {
      prompt("Copy join link:", url);
    }
  });
}

if (!code) {
  roomCodeEl.textContent = "—";
  showTableError(
    "No room code in URL.",
    "Tap Host game on the lobby to create a room."
  );
} else {
  roomCodeEl.textContent = code;
}

try {
  onValue(ref(db, ".info/connected"), (snap) => setTableConn(snap.val() === true), () => setTableConn(false));
} catch (e) {
  console.error("conn listener failed", e);
  setTableConn(false);
}

if (code) {
  watchRoom(code, (room) => {
    if (!room || !room.meta) {
      showTableError(
        `No room found for "${code}".`,
        "It may have ended, or Firebase was blocked. Disable Enhanced Tracking Protection and Host again."
      );
      return;
    }
    tableErrorEl.classList.add("hidden");
    tableErrorEl.innerHTML = "";
    render(room);
  });
}

function tileFace(tile) {
  const div = document.createElement("div");
  const colorCls = tile.color === "B" ? "tile--black" : "tile--white";
  if (tile.revealed) {
    div.className = `tile ${colorCls} tile--revealed tile--sm`;
    div.textContent = String(tile.value);
    div.title = `${tile.color === "B" ? "Black" : "White"} ${tile.value} (revealed)`;
  } else {
    div.className = `tile ${colorCls} tile--down tile--sm`;
    div.title = tile.color === "B" ? "Black tile" : "White tile";
    const dot = document.createElement("span");
    dot.className = "tile-dot";
    div.appendChild(dot);
  }
  return div;
}

function render(room) {
  const meta = room.meta || {};
  const players = room.players || {};
  const hands = room.hands || {};
  const pile = room.pile || { B: [], W: [] };
  const drawn = room.drawn || {};
  const ordered = sortPlayersByOrder(players);

  // Pile counts
  const pileEl = document.getElementById("pile-counts");
  if (pileEl) {
    const b = Array.isArray(pile.B) ? pile.B.length : 0;
    const w = Array.isArray(pile.W) ? pile.W.length : 0;
    pileEl.textContent = meta.status === "lobby" ? "Not dealt" : `B ${b} · W ${w} (${b + w} left)`;
  }

  // Status badge + turn (+ drawn note for the current player).
  const statusBadge = document.getElementById("status-badge");
  if (statusBadge) {
    statusBadge.textContent = meta.status === "playing" ? "Playing" : meta.status === "ended" ? "Ended" : "Lobby";
  }
  const turnLabel = document.getElementById("turn-label");
  if (turnLabel) {
    if (meta.status === "lobby") {
      turnLabel.textContent = ordered.length >= 2
        ? `${ordered.length}/4 players — ready to start`
        : `${ordered.length}/4 players — need 2–4`;
    } else if (meta.status === "playing") {
      const cur = meta.currentTurn && players[meta.currentTurn] ? players[meta.currentTurn].name : "—";
      const drew = meta.currentTurn && drawn[meta.currentTurn] && meta.drawnColor
        ? ` · has drawn a ${meta.drawnColor === "B" ? "black" : "white"} tile`
        : "";
      turnLabel.textContent = `Turn: ${cur} · phase: ${meta.phase || "draw"}${drew}`;
    } else if (meta.status === "ended") {
      const w = meta.winner && players[meta.winner] ? players[meta.winner].name : "—";
      turnLabel.textContent = `Winner: ${w}`;
    }
  }

  // Player slots — hidden tiles color-only, revealed tiles show their number.
  const slots = document.querySelectorAll(".board-player-slot");
  const slotsByIdx = {};
  slots.forEach((el) => {
    const idx = Number(el.dataset.slot);
    slotsByIdx[idx] = el;
    el.innerHTML = "";
    el.classList.add("hidden");
  });

  ordered.slice(0, 4).forEach(([id, p], idx) => {
    const isActive = meta.currentTurn === id && meta.status === "playing";
    const card = document.createElement("div");
    card.className = "card player-board" + (isActive ? " card--active" : "");
    card.style.marginBottom = "0";

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.justifyContent = "space-between";
    head.style.alignItems = "flex-start";
    head.style.marginBottom = "0.35rem";
    const nameEl = document.createElement("div");
    nameEl.style.fontFamily = "'Space Grotesk', sans-serif";
    nameEl.style.fontWeight = isActive ? "800" : "700";
    nameEl.style.fontSize = "0.95rem";
    nameEl.textContent = p.name + (p.connected === false ? " (offline)" : "") + (p.eliminated ? " (out)" : "");
    head.appendChild(nameEl);
    const headRight = document.createElement("div");
    headRight.style.display = "flex";
    headRight.style.gap = "0.3rem";
    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Turn";
      headRight.appendChild(badge);
    }
    head.appendChild(headRight);
    card.appendChild(head);

    const tray = document.createElement("div");
    tray.className = "player-tray";
    const hand = hands[id] || [];
    if (!hand.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.fontSize = "0.82rem";
      empty.textContent = meta.status === "lobby" ? "In lobby — no tiles yet" : "No tiles";
      tray.appendChild(empty);
    } else {
      hand.forEach((t) => tray.appendChild(tileFace(t)));
    }
    card.appendChild(tray);

    const foot = document.createElement("div");
    foot.style.display = "flex";
    foot.style.justifyContent = "space-between";
    foot.style.alignItems = "center";
    foot.style.marginTop = "0.4rem";
    const metaEl = document.createElement("div");
    metaEl.className = "muted";
    metaEl.style.fontSize = "0.78rem";
    metaEl.textContent = p.connected === false ? "Offline" : `${hand.length} tiles`;
    foot.appendChild(metaEl);
    if (host && meta.status === "lobby") {
      const kickBtn = document.createElement("button");
      kickBtn.textContent = "Kick";
      kickBtn.className = "danger";
      kickBtn.style.padding = "0.18rem 0.45rem";
      kickBtn.style.fontSize = "0.7rem";
      kickBtn.style.opacity = "0.72";
      kickBtn.onclick = async () => {
        if (!confirm(`Kick ${p.name}? Their tiles will be removed.`)) return;
        try { await kickPlayer(code, id); }
        catch (e) { alert("Kick failed: " + (e.message || e)); }
      };
      foot.appendChild(kickBtn);
    }
    card.appendChild(foot);

    const slot = slotsByIdx[idx];
    if (slot) {
      slot.classList.remove("hidden");
      slot.appendChild(card);
    }
  });

  for (let i = ordered.length; i < 4; i++) {
    const slot = slotsByIdx[i];
    if (slot) {
      slot.classList.remove("hidden");
      slot.innerHTML = `<div class="card" style="opacity:0.45; text-align:center;"><p class="muted">Empty</p><p class="muted" style="font-size:0.75rem;">Waiting for player</p></div>`;
    }
  }

  renderLastAction(room);

  const statusEl = document.getElementById("status");
  if (meta.status === "ended") {
    const w = meta.winner && players[meta.winner] ? players[meta.winner].name : "—";
    statusEl.textContent = `Game over — winner: ${w}`;
    statusEl.className = "banner banner--success";
  } else {
    statusEl.className = "banner hidden";
  }
  toggleWinOverlay(room);

  // Host-only controls.
  const startBtn = document.getElementById("start-btn");
  const resetBtn = document.getElementById("reset-btn");
  const endBtn = document.getElementById("end-btn");
  const hostHint = document.getElementById("host-hint");
  const playerCount = ordered.length;
  const canStart = host && meta.status === "lobby" && playerCount >= 2 && playerCount <= 4;
  startBtn.classList.toggle("hidden", !canStart);
  if (canStart) {
    const per = playerCount === 4 ? 3 : 4;
    startBtn.textContent = `Start game — deal ${per} each (${playerCount} players)`;
  }

  const showHost = host && !!meta;
  resetBtn.classList.toggle("hidden", !showHost);
  endBtn.classList.toggle("hidden", !showHost);
  hostHint.classList.toggle("hidden", !showHost);
  if (!host && hostHint) {
    hostHint.textContent = "Host controls live on the device that created this room.";
  }
}

function renderLastAction(room) {
  const box = document.getElementById("last-action");
  if (!box) return;
  const la = room.lastAction;
  const players = room.players || {};
  box.innerHTML = "";
  if (!la || !la.by) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const byName = players[la.by]?.name || "Someone";
  if (la.type === "guess") {
    const targetName = players[la.target]?.name || "opponent";
    const div = document.createElement("div");
    div.className = "guess-result " + (la.correct ? "guess-result--correct" : "guess-result--wrong");
    const head = document.createElement("div");
    head.textContent = la.correct
      ? `✓ ${byName} revealed ${targetName}'s ${la.tileId}!`
      : `✕ ${byName} guessed ${la.value} on ${targetName} — wrong!`;
    div.appendChild(head);
    const sub = document.createElement("span");
    sub.className = "guess-result__sub";
    sub.textContent = la.correct ? `${targetName} · tile ${la.tileId} = ${la.value}` : `${byName}'s drawn tile is revealed`;
    div.appendChild(sub);
    box.appendChild(div);
  } else if (la.type === "draw" && !la.skipped) {
    box.innerHTML = `<div class="muted" style="font-size:0.85rem; text-align:center;">🎴 ${escapeHtml(byName)} drew a ${la.color === "B" ? "black" : "white"} tile</div>`;
  } else if (la.type === "continue" && la.again) {
    box.innerHTML = `<div class="muted" style="font-size:0.85rem; text-align:center;">→ ${escapeHtml(byName)} guesses again</div>`;
  } else if (la.type === "continue" && !la.again) {
    box.innerHTML = `<div class="muted" style="font-size:0.85rem; text-align:center;">■ ${escapeHtml(byName)} stops — tile placed face-down</div>`;
  } else {
    box.innerHTML = `<div class="muted" style="font-size:0.85rem; text-align:center;">${escapeHtml(byName)} continues</div>`;
  }
}

function toggleWinOverlay(room) {
  const meta = room.meta || {};
  const existing = document.getElementById("win-overlay");
  if (meta.status !== "ended") { winDismissed = false; if (existing) existing.remove(); return; }
  if (winDismissed) return;
  const wname = meta.winner && room.players?.[meta.winner] ? room.players[meta.winner].name : null;
  let overlay = existing;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "win-overlay";
    overlay.className = "win-overlay";
    const title = document.createElement("div");
    title.className = "win-overlay__title";
    title.textContent = "🏆";
    overlay.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "win-overlay__subtitle";
    overlay.appendChild(sub);
    const actions = document.createElement("div");
    actions.className = "win-overlay__actions";
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "win-overlay__btn win-overlay__btn--ghost";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.onclick = () => { winDismissed = true; overlay.remove(); };
    actions.appendChild(dismissBtn);
    overlay.appendChild(actions);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { winDismissed = true; overlay.remove(); } });
    document.body.appendChild(overlay);
  }
  const sub = overlay.querySelector(".win-overlay__subtitle");
  if (sub) sub.textContent = wname ? `${wname} wins!` : "Game over";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

document.getElementById("start-btn").addEventListener("click", async (e) => {
  if (!host) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Dealing…";
  try {
    await startGame(code);
  } catch (err) {
    console.error("start failed", err);
    alert("Start failed: " + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (!host) return;
  if (!confirm("Reset to lobby? Keeps players but clears all tiles.")) return;
  try { await resetRoom(code); }
  catch (e) { alert("Reset failed: " + (e.message || e)); }
});

document.getElementById("end-btn").addEventListener("click", async () => {
  if (!host) return;
  if (!confirm("End session? This deletes the room for everyone.")) return;
  try {
    await endRoom(code);
  } catch (e) {
    console.error("end failed", e);
    alert("Failed to end: " + e.message);
    return;
  }
  document.getElementById("room-code").textContent = "—";
  showTableError("Session ended.", "Share a new code from Host.");
});
