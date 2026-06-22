/* =====================================================================
   gamehud.js — NovaVerse premium gameplay HUD layer
   Browser ES module. The game loop feeds it live state at ~20Hz.
   Renders: objective strip, scoreboard, Time Bomb readout, win/lobby banner.

   API:
     import { createGameHud } from './gamehud.js';
     const hud = createGameHud();
     hud.update(gs, selfId);   // call every game tick (~20Hz)
     hud.destroy();            // tear down + clear timers

   gs = {
     players: [{id, name, color, score, alive, hasBomb}],
     objective: {mode, text, timer},
     bomb: {holderId, timer} | null,
     phase: 'lobby' | 'playing' | 'roundover',
     winner: {id, name} | null
   }

   Styling lives entirely in hud.css (all classes prefixed nvg-).
   The overlay is a fixed, pointer-events:none display layer — it never
   blocks input and never sits over the play center for long.
   English in code, Danish in UI strings. No emoji anywhere.
   ===================================================================== */

/* ---------------------------------------------------------------------
   Formatting helpers (pure — no internal clock; the game owns the timers)
   --------------------------------------------------------------------- */

// Objective / generic timer: ">=60 -> M:SS", "0..59 -> Ns", null/NaN/neg -> "".
function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }
  return `${s}s`;
}

// Bomb timer: tight whole-seconds, clamped at 0 (the round logic owns the boom).
function formatBombTimer(seconds) {
  if (seconds == null || !isFinite(seconds)) return '';
  return String(Math.max(0, Math.floor(seconds)));
}

// Write text only when it actually changed (cheap; keeps update() hot-loop quiet).
function setText(el, value) {
  const str = value == null ? '' : String(value);
  if (el.textContent !== str) el.textContent = str;
}

// Toggle a class only when the desired state differs from the current one.
function toggleClass(el, cls, on) {
  if (on) {
    if (!el.classList.contains(cls)) el.classList.add(cls);
  } else if (el.classList.contains(cls)) {
    el.classList.remove(cls);
  }
}

/* ---------------------------------------------------------------------
   createGameHud — factory. Builds the DOM once, returns {update, destroy}.
   --------------------------------------------------------------------- */
export function createGameHud() {
  /* ----- timer bookkeeping (everything cleared on destroy) ----- */
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }
  function cancel(id) {
    if (id != null) { clearTimeout(id); timers.delete(id); }
  }

  /* =================================================================
     BUILD DOM ONCE
     ================================================================= */
  const root = document.createElement('div');
  root.className = 'nvg-hud';
  // Whole overlay is decorative; meaningful changes go through the
  // hoisted aria-live announcer below (avoids the aria-hidden trap).
  root.setAttribute('aria-hidden', 'true');

  // --- 1. Objective strip (top-center) ---
  const objective = document.createElement('div');
  objective.className = 'nvg-objective';
  const objText = document.createElement('span');
  objText.className = 'nvg-obj-text';
  const objTimer = document.createElement('span');
  objTimer.className = 'nvg-obj-timer';
  objective.append(objText, objTimer);

  // --- 2. Scoreboard (top-right, below the room chip) ---
  const scoreboard = document.createElement('div');
  scoreboard.className = 'nvg-scoreboard';
  const sbTitle = document.createElement('div');
  sbTitle.className = 'nvg-sb-title';
  sbTitle.textContent = 'STILLING';
  const sbList = document.createElement('ul');
  sbList.className = 'nvg-sb-list';
  scoreboard.append(sbTitle, sbList);

  // --- 3. Time Bomb readout (top-center, just under objective) ---
  const bomb = document.createElement('div');
  bomb.className = 'nvg-bomb nvg-hidden';
  const bombLabel = document.createElement('span');
  bombLabel.className = 'nvg-bomb-label';
  const bombTimer = document.createElement('span');
  bombTimer.className = 'nvg-bomb-timer';
  bomb.append(bombLabel, bombTimer);

  // --- 4. Center banner (win / lobby) ---
  const banner = document.createElement('div');
  banner.className = 'nvg-banner nvg-hidden';
  const bannerTitle = document.createElement('span');
  bannerTitle.className = 'nvg-banner-title';
  banner.append(bannerTitle);

  root.append(objective, scoreboard, bomb, banner);
  document.body.appendChild(root);

  // --- Hoisted, visually-hidden screen-reader announcer ---
  // Lives OUTSIDE the aria-hidden overlay so polite live updates are heard.
  // Only written on real state changes (never the 20Hz hot path).
  const announcer = document.createElement('div');
  announcer.className = 'nvg-sr';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  document.body.appendChild(announcer);

  /* =================================================================
     STATE CACHE — skip DOM writes when nothing changed
     ================================================================= */
  let lastObjText = null;
  let lastObjTimer = null;

  let lastBombMode = null;     // 'MINE' | 'ELIM' | 'CARRY' | 'HIDDEN'
  let lastBombTimer = null;

  let lastPhase = null;
  let lastBannerMode = null;   // 'WIN' | 'LOBBY' | 'HIDDEN'
  let lastBannerText = null;
  let bannerFadeTimer = null;

  let lastAnnounced = null;

  // Scoreboard rows keyed by player id: id -> {el,dot,name,score,lastScore,lastColor,lastAlive}
  const rows = new Map();

  /* ----- screen-reader announce (only on change) ----- */
  function announce(text) {
    if (!text || text === lastAnnounced) return;
    lastAnnounced = text;
    announcer.textContent = text;
  }

  /* =================================================================
     OBJECTIVE
     ================================================================= */
  function renderObjective(gs) {
    const obj = gs.objective || {};
    const text = obj.text ?? '';
    if (lastObjText !== text) { setText(objText, text); lastObjText = text; }

    // The objective strip shows ITS OWN timer. The bomb has a separate
    // readout, so we never borrow the bomb timer here.
    const tStr = (typeof obj.timer === 'number' && obj.timer > 0)
      ? formatTime(obj.timer) : '';
    if (lastObjTimer !== tStr) {
      setText(objTimer, tStr);
      toggleClass(objTimer, 'nvg-hidden', tStr === '');
      lastObjTimer = tStr;
    }
  }

  /* =================================================================
     SCOREBOARD — diff/patch, reuse rows keyed by id
     ================================================================= */
  function makeRow(player) {
    const li = document.createElement('li');
    li.className = 'nvg-sb-row';
    const dot = document.createElement('span');
    dot.className = 'nvg-sb-dot';
    const name = document.createElement('span');
    name.className = 'nvg-sb-name';
    const score = document.createElement('span');
    score.className = 'nvg-sb-score';
    li.append(dot, name, score);
    return { el: li, dot, name, score, lastScore: null, lastColor: null, lastAlive: null };
  }

  function flashScore(row) {
    // Remove + force reflow + re-add so the CSS keyframe restarts reliably.
    row.score.classList.remove('nvg-flash');
    void row.score.offsetWidth;
    row.score.classList.add('nvg-flash');
    later(() => row.score.classList.remove('nvg-flash'), 600);
  }

  function renderScoreboard(players, selfId) {
    const list = Array.isArray(players) ? players : [];

    // Sort by score DESC; stable tiebreak by id so equal scores don't jitter.
    const sorted = [...list]
      .filter(p => p && p.id != null)
      .sort((a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        String(a.id).localeCompare(String(b.id))
      );

    const seen = new Set();
    sorted.forEach((p) => {
      seen.add(p.id);
      let row = rows.get(p.id);
      if (!row) { row = makeRow(p); rows.set(p.id, row); }

      // Color dot (inline — JS owns the player color).
      const color = p.color || 'var(--nova-cyan)';
      if (row.lastColor !== color) { row.dot.style.background = color; row.lastColor = color; }

      setText(row.name, p.name ?? '');

      const score = p.score ?? 0;
      if (row.lastScore !== null && row.lastScore !== score) flashScore(row);
      if (row.lastScore !== score) { setText(row.score, String(score)); row.lastScore = score; }

      const alive = p.alive !== false;
      if (row.lastAlive !== alive) { toggleClass(row.el, 'nvg-elim', !alive); row.lastAlive = alive; }

      toggleClass(row.el, 'nvg-self', p.id === selfId);
    });

    // Re-append in sorted order (appendChild MOVES existing nodes — no rebuild).
    sorted.forEach((p) => list && sbList.appendChild(rows.get(p.id).el));

    // Drop rows for players who left.
    for (const [id, row] of rows) {
      if (!seen.has(id)) { row.el.remove(); rows.delete(id); }
    }
  }

  /* =================================================================
     TIME BOMB — priority MINE > ELIM > CARRY > HIDDEN
     ================================================================= */
  function bombModeFor(gs, self, selfId) {
    const b = gs.bomb ?? null;
    // 1. Alive and holding the bomb.
    if (b && self && self.alive === true && b.holderId === selfId) return 'MINE';
    // 2. Eliminated during a live round -> calm watching state.
    if (self && self.alive === false && gs.phase === 'playing') return 'ELIM';
    // 3. Bomb active, someone else holds it (or pure spectator).
    if (b) return 'CARRY';
    // 4. Nothing to show.
    return 'HIDDEN';
  }

  function renderBomb(gs, self, selfId) {
    const mode = bombModeFor(gs, self, selfId);
    const b = gs.bomb ?? null;

    if (mode !== lastBombMode) {
      toggleClass(bomb, 'nvg-hidden', mode === 'HIDDEN');
      toggleClass(bomb, 'nvg-bomb-mine', mode === 'MINE');
      toggleClass(bomb, 'nvg-elim-state', mode === 'ELIM');

      if (mode === 'MINE') {
        setText(bombLabel, 'DU HAR BOMBEN - LOEB!');
        announce('Du har bomben - loeb!');
      } else if (mode === 'ELIM') {
        setText(bombLabel, 'Elimineret - du ser paa');
        announce('Elimineret - du ser paa');
      } else if (mode === 'CARRY') {
        setText(bombLabel, 'BOMBE');
      } else {
        setText(bombLabel, '');
      }
      lastBombMode = mode;
    }

    // Countdown — shown for MINE and CARRY (ELIM is calm, no timer).
    const tStr = (mode === 'MINE' || mode === 'CARRY') ? formatBombTimer(b && b.timer) : '';
    if (lastBombTimer !== tStr) {
      setText(bombTimer, tStr);
      toggleClass(bombTimer, 'nvg-hidden', tStr === '');
      lastBombTimer = tStr;
    }
  }

  /* =================================================================
     BANNER — win / lobby, auto-fading, transition-armed (not per-frame)
     ================================================================= */
  function bannerStateFor(gs) {
    if (gs.phase === 'roundover' && gs.winner) {
      const name = (gs.winner.name && String(gs.winner.name).trim()) || 'Ukendt';
      return { mode: 'WIN', text: `${name} vandt runden!` };
    }
    if (gs.phase === 'lobby') return { mode: 'LOBBY', text: 'Venter paa spillere...' };
    return { mode: 'HIDDEN', text: '' };
  }

  function renderBanner(gs) {
    const { mode, text } = bannerStateFor(gs);

    if (text && lastBannerText !== text) { setText(bannerTitle, text); lastBannerText = text; }

    // Only act on a real transition — keeps the auto-fade timer from
    // re-arming every frame.
    if (mode === lastBannerMode) return;
    lastBannerMode = mode;

    cancel(bannerFadeTimer);
    bannerFadeTimer = null;

    toggleClass(banner, 'nvg-banner-win', mode === 'WIN');
    toggleClass(banner, 'nvg-banner-lobby', mode === 'LOBBY');

    if (mode === 'WIN') {
      setText(bannerTitle, text);
      lastBannerText = text;
      toggleClass(banner, 'nvg-hidden', false);
      announce(text);
      // Auto-fade so the win banner never blocks the center for long.
      bannerFadeTimer = later(() => {
        toggleClass(banner, 'nvg-hidden', true);
        bannerFadeTimer = null;
      }, 3500);
    } else if (mode === 'LOBBY') {
      setText(bannerTitle, text);
      lastBannerText = text;
      toggleClass(banner, 'nvg-hidden', false);
      announce('Venter paa spillere');
    } else {
      // HIDDEN (playing, or roundover without a winner) — hide immediately.
      toggleClass(banner, 'nvg-hidden', true);
    }
  }

  /* =================================================================
     PUBLIC API
     ================================================================= */
  function update(gs, selfId) {
    if (!gs) return;
    const self = (Array.isArray(gs.players) ? gs.players : [])
      .find(p => p && p.id === selfId) ?? null;

    renderObjective(gs);
    renderScoreboard(gs.players, selfId);
    renderBomb(gs, self, selfId);
    renderBanner(gs);

    lastPhase = gs.phase;
  }

  function destroy() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    rows.clear();
    if (root.parentNode) root.parentNode.removeChild(root);
    if (announcer.parentNode) announcer.parentNode.removeChild(announcer);
  }

  return { update, destroy };
}
