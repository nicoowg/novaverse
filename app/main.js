// main.js
// NovaVerse 3D play-klient - entrypoint og game loop.
// Binder scene.js (3D-verden + Nova-avatar), controls.js (kamera + input)
// og net.js (autoritativ server via WebSocket) sammen til et spilbart hele.
//
// Render-model:
//   - Egen spiller (id == welcome.id): let client-prediction (vi bevaeger lokalt
//     med det samme og blender bloedt mod serverens autoritative position).
//   - Andre spillere: interpolation - vi lerper mellem de to seneste snapshots.
//   - Ingen server (WS nede): single-player fallback - vi styrer Nova lokalt
//     saa scenen + figur + HUD stadig kan ses.

import * as THREE from 'three';
import { createScene, makeNovaAvatar, makeOrb, makeBombMarker, makeHolderRing, applyAvatarPose } from './scene.js';
import { createControls } from './controls.js';
import { createNet } from './net.js';
import { createChat } from './chat.js';
import { createGameHud } from './gamehud.js';

// --- Laes URL-kontrakten: ?game=&name=&color=&token= ---
const qs = new URLSearchParams(location.search);
const GAME = qs.get('game') || 'nova-hub';
const DEV = qs.has('dev'); // browser-bypass for app-gaten + test-hooks
const NAME = qs.get('name') || 'Spiller';
const COLOR = normalizeHex(qs.get('color')) || '#7C5CFF';
// token laeses men bruges ikke af denne klient direkte (serveren validerer).
const TOKEN = qs.get('token') || '';
// Udstyrede cosmetics (outfit) fra portalen: ?items=id1,id2 -> 3D paa egen avatar.
const ITEMS = (qs.get('items') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Fuld avatar fra portalen, saa figuren i spillet matcher hjemmesiden.
const SKIN = normalizeHex(qs.get('skin')) || '';   // hudfarve
const HAIR = normalizeHex(qs.get('hair')) || '';   // haarfarve
const PRESET = (qs.get('preset') || '').trim();    // kropstype

// Sikr at en farve-streng er et brugbart hex (#RRGGBB).
function normalizeHex(c) {
  if (!c) return null;
  let s = String(c).trim();
  if (s[0] !== '#') s = '#' + s;
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

// --- Tema/map pr. spil: hvert spil er sin egen verden ---
const THEMES = {
  'nova-hub':   { top:'#0d0f19', mid:'#0a0b12', bot:'#07080d', fog:0x07080d, floor:0x161a2b, pillar:0x1c2138, pillarEmissive:0x4d7cff, accents:[0x38e1ff,0x7c5cff,0x4d7cff], variant:'ring',      mode:'social', label:'Nova Hub - moedested',        accentCss:'#8b5cff' },
  'time-bomb':  { top:'#1a0e16', mid:'#120a10', bot:'#0a0608', fog:0x0a0608, floor:0x231019, pillar:0x3a1622, pillarEmissive:0xff5c7a, accents:[0xff5c7a,0xffc24b,0xff71ce], variant:'arena',     mode:'bomb',   label:'Time Bomb - send bomben videre!', accentCss:'#ff5c7a' },
  'sky-parkour':{ top:'#0a1620', mid:'#08121a', bot:'#060d12', fog:0x060d12, floor:0x10222b, pillar:0x123040, pillarEmissive:0x38e1ff, accents:[0x38e1ff,0x4d7cff],         variant:'platforms', mode:'parkour',label:'Sky Parkour - naa toppen',       accentCss:'#38e1ff' },
  'tag-arena':  { top:'#1a160c', mid:'#120f08', bot:'#0a0806', fog:0x0a0806, floor:0x231d10, pillar:0x3a2f16, pillarEmissive:0xffc24b, accents:[0xffc24b,0xff71ce],         variant:'open',      mode:'tag',    label:'Tag Arena - undvig!',            accentCss:'#ffc24b' },
  'nova-drift': { top:'#0a0f1e', mid:'#080b16', bot:'#06080f', fog:0x06080f, floor:0x141a2b, pillar:0x16223a, pillarEmissive:0x4d7cff, accents:[0x4d7cff,0x38e1ff],         variant:'track',     mode:'race',   label:'Nova Drift - hurtigste vinder',  accentCss:'#4d7cff' },
  'crystal-caves':{ top:'#0a1a1e', mid:'#071216', bot:'#040b0d', fog:0x040b0d, floor:0x0c2024, pillar:0x10353a, pillarEmissive:0x2ee6c0, accents:[0x2ee6c0,0x38e1ff],       variant:'caverns',   mode:'explore',label:'Crystal Caves - udforsk grotterne', accentCss:'#2ee6c0' },
  'neon-city':  { top:'#15091a', mid:'#0e0712', bot:'#08040b', fog:0x08040b, floor:0x1a0f24, pillar:0x2a1640, pillarEmissive:0xff71ce, accents:[0xff71ce,0x7c5cff,0x38e1ff], variant:'city',      mode:'social', label:'Neon City - byens moedeplads',   accentCss:'#ff71ce' },
  'sky-garden': { top:'#0c1810', mid:'#08110b', bot:'#050a07', fog:0x0a140d, floor:0x10241a, pillar:0x163a26, pillarEmissive:0x6ee787, accents:[0x6ee787,0x38e1ff],         variant:'garden',    mode:'social', label:'Sky Garden - have over skyerne', accentCss:'#6ee787' },
};
const THEME = THEMES[GAME] || THEMES['nova-hub'];

// --- DOM-referencer (HUD-kontrakt fra hud.css) ---
const canvas = document.getElementById('stage');
const boot = document.getElementById('boot');
const bootText = document.getElementById('boot-text');
const elPlayerDot = document.getElementById('player-dot');
const elPlayerName = document.getElementById('player-name');
const elStatRoom = document.getElementById('stat-room');
const elStatPlayers = document.getElementById('stat-players');
const elStatPing = document.getElementById('stat-ping');
const elConnDot = document.getElementById('conn-dot');
const elNametags = document.getElementById('nametags');

// Fyld den statiske del af HUD'en med det samme.
elPlayerName.textContent = NAME;
elPlayerDot.style.background = COLOR;
elPlayerDot.style.boxShadow = `0 0 10px 1px ${hexToRgba(COLOR, 0.55)}`;
elStatRoom.textContent = GAME;
document.title = `NovaVerse - ${GAME}`;

// Gem identitet til sessionStorage saa hub'en kan genfinde den (URL er primaer).
try {
  sessionStorage.setItem('nv_name', NAME);
  sessionStorage.setItem('nv_color', COLOR);
  if (TOKEN) sessionStorage.setItem('nv_token', TOKEN);
  if (SKIN) sessionStorage.setItem('nv_skin', SKIN);
  if (HAIR) sessionStorage.setItem('nv_hair', HAIR);
  if (PRESET) sessionStorage.setItem('nv_preset', PRESET);
  if (ITEMS.length) sessionStorage.setItem('nv_items', ITEMS.join(','));
} catch (e) { /* file:// kan blokere storage - URL baerer altid identiteten */ }

// "Forlad spil" -> tilbage til in-app hub (Roblox-stil), identitet bevaret i URL.
(function wireLeave() {
  const btn = document.getElementById('leave-game');
  if (!btn) return;
  const q = new URLSearchParams();
  q.set('name', NAME);
  q.set('color', COLOR);
  if (TOKEN) q.set('token', TOKEN);
  if (SKIN) q.set('skin', SKIN);
  if (HAIR) q.set('hair', HAIR);
  if (PRESET) q.set('preset', PRESET);
  if (ITEMS.length) q.set('items', ITEMS.join(','));
  btn.addEventListener('click', () => { location.href = 'hub.html?' + q.toString(); });
})();

// --- Byg den 3D-scene (kan kaste hvis WebGL mangler; vi viser fejl i boot) ---
let world;
try {
  world = createScene(canvas, THEME);
} catch (err) {
  bootFail('Kunne ikke starte 3D (WebGL?). ' + (err && err.message ? err.message : ''));
  throw err;
}
const { scene, camera, renderer, resize } = world;
// Map-colliders (fra scene.js) saa man ikke kan gaa gennem mure/soejler/dais.
const COLLIDERS = Array.isArray(world.colliders) ? world.colliders : [];
const PLAYER_R = 0.38; // spillerens radius til collision
const BG_GLYPHS = (scene.userData && Array.isArray(scene.userData.bgGlyphs)) ? scene.userData.bgGlyphs : [];

// Skub en XZ-position ud af alle colliders (kun naar spillerens hoejde overlapper).
// Returnerer true hvis der blev korrigeret (saa vi kan daempe farten ind i vaeggen).
const STEP_H = 0.7; // lave ting (dais, lave plader) blokerer ikke - man kan staa paa/ved dem
function resolveCollisions(pos) {
  const feetY = pos.y;
  const headY = pos.y + 1.9;
  let hit = false;
  for (let iter = 0; iter < 2; iter++) {
    for (const c of COLLIDERS) {
      if (c.type === 'box') {
        const minY = c.min[1], maxY = c.max[1];
        if (maxY <= feetY + STEP_H) continue; // lav nok til at traede paa -> ingen vaeg
        if (headY <= minY || feetY >= maxY) continue; // ingen hoejde-overlap
        // Naermeste punkt paa rektanglet (XZ) til spilleren.
        const nx = Math.max(c.min[0], Math.min(pos.x, c.max[0]));
        const nz = Math.max(c.min[2], Math.min(pos.z, c.max[2]));
        let dx = pos.x - nx, dz = pos.z - nz;
        let d2 = dx * dx + dz * dz;
        if (d2 > PLAYER_R * PLAYER_R) continue; // ingen overlap
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2); const push = PLAYER_R - d;
          pos.x += (dx / d) * push; pos.z += (dz / d) * push;
        } else {
          // Center inde i boksen: skub ud ad naermeste flade.
          const dl = pos.x - c.min[0], dr = c.max[0] - pos.x;
          const db = pos.z - c.min[2], df = c.max[2] - pos.z;
          const m = Math.min(dl, dr, db, df);
          if (m === dl) pos.x = c.min[0] - PLAYER_R;
          else if (m === dr) pos.x = c.max[0] + PLAYER_R;
          else if (m === db) pos.z = c.min[2] - PLAYER_R;
          else pos.z = c.max[2] + PLAYER_R;
        }
        hit = true;
      } else if (c.type === 'cylinder') {
        if (c.h <= feetY + STEP_H) continue; // lav nok til at traede paa -> ingen vaeg
        if (headY <= 0 || feetY >= c.h) continue;
        let dx = pos.x - c.x, dz = pos.z - c.z;
        const rr = c.r + PLAYER_R;
        let d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-9) continue;
        const d = Math.sqrt(d2); const push = rr - d;
        pos.x += (dx / d) * push; pos.z += (dz / d) * push;
        hit = true;
      }
    }
  }
  return hit;
}

// Gameplay-HUD (scoreboard, bombe-timer, objektiv, vind-banner) - drevet af server-state.
const gameHud = createGameHud();

// --- Collectible-orbs: id -> mesh. Renderes fra server-state.orbs. ---
const orbMeshes = new Map();
const ORB_ACCENT = (THEME.accents && THEME.accents[0]) || 0x38e1ff;
function syncOrbs(orbs) {
  const live = new Set();
  for (const o of (orbs || [])) {
    if (!o || o.id == null || !o.pos) continue;
    live.add(o.id);
    let m = orbMeshes.get(o.id);
    if (!m) { m = makeOrb(ORB_ACCENT); m.userData.baseY = o.pos[1]; scene.add(m); orbMeshes.set(o.id, m); }
    m.position.set(o.pos[0], o.pos[1], o.pos[2]);
    m.userData.baseY = o.pos[1];
  }
  for (const id of Array.from(orbMeshes.keys())) {
    if (!live.has(id)) { const m = orbMeshes.get(id); scene.remove(m); orbMeshes.delete(id); }
  }
}

// --- Bombe-markoer + holder-ring (Time Bomb). Foelger bombe-holderens avatar. ---
let bombMarker = null, holderRing = null, bombHolderId = null;
function ensureBombVisuals() {
  if (!bombMarker) { bombMarker = makeBombMarker(); bombMarker.visible = false; scene.add(bombMarker); }
  if (!holderRing) { holderRing = makeHolderRing('#ff5c7a'); holderRing.visible = false; scene.add(holderRing); }
}

// Kontroller (kamera + input). domElement = canvas til pointer lock.
const controls = createControls(camera, canvas);
// Kamera-collision: kameraet trækkes ind foran vaegge i stedet for at klippe igennem.
if (typeof controls.setColliders === 'function') controls.setColliders(COLLIDERS);

// --- Spiller-registret: id -> { group, target, prev, lerpStart, isSelf } ---
const avatars = new Map();

// Egen lokale tilstand til client-prediction.
const localPos = new THREE.Vector3(0, 0, 0); // vores predikterede position (feet)
const vel = new THREE.Vector3();             // vandret fart (x,z) - glat accel/decel
let localVelY = 0;          // vertikal hastighed (hop)
let onGround = true;
const MOVE_SPEED = 7.5;     // enheder/sek - SKAL matche gamed (Roblox-agtig fart)
const ACCEL = 16;           // hvor hurtigt vi naar maalfarten (snappy Roblox-respons)
const GRAVITY = -26;        // enheder/sek^2 - matcher gamed
const JUMP_V = 10.0;        // start-hop-hastighed - matcher gamed
const PREDICT_BLEND = 6;    // hvor haardt vi blender mod serverens autoritet

// Byg makeNovaAvatar-opts: egen figur fra URL, fjernspillere fra deres state-felter,
// saa ALLE ser ud som paa hjemmesiden (hud/haar/kropstype/outfit).
function avatarOpts(isSelf, av) {
  if (isSelf) {
    return { skin: SKIN || undefined, hair: HAIR || undefined, preset: PRESET || undefined, cosmetics: ITEMS };
  }
  if (!av) return null;
  const items = Array.isArray(av.items)
    ? av.items
    : (av.items ? String(av.items).split(',').map((s) => s.trim()).filter(Boolean) : []);
  return { skin: av.skin || undefined, hair: av.hair || undefined, preset: av.preset || undefined, cosmetics: items };
}

// Sikrer at vi har en avatar-group for et id; opretter ved behov.
// av (valgfri) = {skin,hair,preset,items} for fjernspillere (fra state-snapshot).
function ensureAvatar(id, color, isSelf, av) {
  let a = avatars.get(id);
  if (!a) {
    // Egen + fjernspillere bygges nu med fuld avatar saa man ser hvordan alle ser ud.
    const group = makeNovaAvatar(color || COLOR, avatarOpts(isSelf, av));
    scene.add(group);
    a = {
      group,
      // Interpolation: prev/target er de to seneste server-snapshots.
      prev: new THREE.Vector3(),
      target: new THREE.Vector3(),
      prevYaw: 0,
      targetYaw: 0,
      snapTime: 0,        // hvornaar target sidst blev sat
      snapDur: 0.05,      // varighed mellem snapshots (~20 Hz = 50 ms)
      isSelf: !!isSelf,
      name: isSelf ? NAME : '',
      color: color || COLOR,
      // navneskilt-element (skjules for egen figur i tredjeperson)
      tag: makeNametag(),
    };
    // Init navneskilt: navn + prik-farve med det samme (ogsaa i single-player).
    if (a.tag) {
      a.tag._label.textContent = a.name;
      a.tag._dot.style.background = a.color;
      // Ingen navneskilt over dig selv - kameraet sidder bag dig.
      if (isSelf) a.tag.style.display = 'none';
    }
    avatars.set(id, a);
  }
  return a;
}

// Opret et HTML navneskilt og put i #nametags.
function makeNametag() {
  const el = document.createElement('div');
  el.className = 'nametag';
  const dot = document.createElement('span');
  dot.className = 'nametag-dot';
  const label = document.createElement('span');
  el.appendChild(dot);
  el.appendChild(label);
  el._label = label;
  el._dot = dot;
  elNametags.appendChild(el);
  return el;
}

function removeAvatar(id) {
  const a = avatars.get(id);
  if (!a) return;
  scene.remove(a.group);
  if (a.tag && a.tag.parentNode) a.tag.parentNode.removeChild(a.tag);
  avatars.delete(id);
}

// --- Netvaerk ---
const net = createNet({ game: GAME, name: NAME, color: COLOR, skin: SKIN, hair: HAIR, preset: PRESET, items: ITEMS });

// In-game chat: send via serveren (broadcaster til hele rummet), modtag via onChat.
const chat = createChat({ onSend: (text) => net.sendChat(text) });
net.onChat = (msg) => chat.receive(msg);

let selfId = null;
let lastSnapshotPlayers = 0;
let lastStateAt = 0; // performance.now() for seneste server-state (robust forbindelses-indikator)

net.onWelcome = (id) => {
  // Hvis vi naaede at falde til single-player foer WS kom op, saa fortryd det nu
  // og adoptér serverens identitet, saa fjernspillere rendres korrekt.
  if (localOnly) {
    removeAvatar('__local__');
    localOnly = false;
  }
  selfId = id;
  // Sikr egen avatar findes med det samme (selv foer foerste state).
  const a = ensureAvatar(id, COLOR, true);
  a.name = NAME;
  a.target.copy(localPos);
  a.prev.copy(localPos);
};

net.onState = (msg) => {
  const players = Array.isArray(msg.players) ? msg.players : [];
  lastSnapshotPlayers = players.length;
  lastStateAt = performance.now();
  const now = performance.now() / 1000;
  const seen = new Set();

  for (const p of players) {
    if (!p || p.id == null) continue;
    seen.add(p.id);
    const isSelf = p.id === selfId;
    const a = ensureAvatar(p.id, p.color, isSelf, p);
    a.name = p.name || a.name;
    if (a.tag && a.tag._label.textContent !== a.name) a.tag._label.textContent = a.name;
    if (a.tag) {
      a.tag._dot.style.background = p.color || a.color;
    }

    const px = p.pos ? p.pos[0] : 0;
    const py = p.pos ? p.pos[1] : 0;
    const pz = p.pos ? p.pos[2] : 0;

    if (isSelf) {
      // Egen spiller: gem serverens autoritet til at blende prediction mod.
      a.serverPos = a.serverPos || new THREE.Vector3();
      a.serverPos.set(px, py, pz);
      a.hasServer = true;
    } else {
      // Andre: skub target -> prev og saet nyt target for interpolation.
      a.prev.copy(a.target);
      a.target.set(px, py, pz);
      a.prevYaw = a.targetYaw;
      a.targetYaw = (typeof p.yaw === 'number') ? p.yaw : a.targetYaw;
      a.snapDur = Math.max(0.02, now - a.snapTime || 0.05);
      a.snapTime = now;
    }
  }

  // Fjern spillere der ikke laengere er i snapshot (udover dem leave allerede tog).
  for (const id of Array.from(avatars.keys())) {
    if (id !== selfId && !seen.has(id)) removeAvatar(id);
  }

  if (DEV) window.__lastState = msg; // dev: lader verifikation laese orbs/score/bombe
  // Gameplay: synk orbs + bombe-holder + foed gameplay-HUD'en server-state.
  syncOrbs(msg.orbs);
  bombHolderId = (msg.bomb && msg.bomb.holderId) ? msg.bomb.holderId : null;
  gameHud.update({
    players: players,
    objective: msg.objective || null,
    bomb: msg.bomb || null,
    phase: msg.phase || 'playing',
    winner: msg.winner || null,
  }, selfId);
};

net.onLeave = (id) => { removeAvatar(id); };

// --- Single-player fallback ---
// Hvis WS ikke kommer op inden for et oejeblik, opretter vi en lokal Nova
// saa scenen + figur + HUD stadig vises (proven not claimed).
let localOnly = false;
function ensureLocalFallback() {
  if (net.isConnected() || selfId) return;
  localOnly = true;
  selfId = '__local__';
  const a = ensureAvatar(selfId, COLOR, true);
  a.name = NAME;
  a.target.copy(localPos);
  a.prev.copy(localPos);
}
setTimeout(ensureLocalFallback, 3000);

// --- Input -> server (~30 Hz) ---
let seq = 0;
let inputAccum = 0;
const INPUT_HZ = 30;
const INPUT_DT = 1 / INPUT_HZ;

// --- Render loop ---
let last = performance.now();
let booted = false;

function tickBody(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000); // klamp dt mod hak ved fane-skift
  last = nowMs;

  controls.update(dt);

  // 1) Laes input og opdater egen predikterede position (kamera-relativt).
  // Mens man skriver i chatten ignoreres bevaegelses-input (men kameraet maa gerne kigge).
  const typing = chat && chat.isTyping();
  const dir = typing ? [0, 0] : controls.getMoveDir(); // world-space [x,z], normaliseret
  const yaw = controls.getYaw();
  const wantJump = typing ? false : controls.consumeJump();

  // Bevaeg lokalt med glat accel/decel (fjerner det "stive/mean" oejeblikkelige snap):
  // farten trailes mod maalfarten, saa start og stop foeles vaegtet og bloedt.
  const k = 1 - Math.exp(-dt * ACCEL);
  vel.x += (dir[0] * MOVE_SPEED - vel.x) * k;
  vel.z += (dir[1] * MOVE_SPEED - vel.z) * k;
  localPos.x += vel.x * dt;
  localPos.z += vel.z * dt;

  // Hop + tyngdekraft (lokal feel; serveren er stadig autoritativ for pos).
  if (wantJump && onGround) { localVelY = JUMP_V; onGround = false; }
  localVelY += GRAVITY * dt;
  localPos.y += localVelY * dt;
  if (localPos.y <= 0) { localPos.y = 0; localVelY = 0; onGround = true; }

  // Collision mod map'et (XZ): skub ud af mure/soejler/dais saa man ikke gaar igennem.
  resolveCollisions(localPos);

  // 2) Send input til serveren ~30 Hz.
  inputAccum += dt;
  if (inputAccum >= INPUT_DT) {
    inputAccum = 0;
    if (net.isConnected()) {
      net.sendInput(seq++, dir, wantJump, yaw);
    }
  }

  // 3) Opdater egen avatar (prediction blendet mod server-autoritet).
  const now = nowMs / 1000;
  const me = avatars.get(selfId);
  if (me) {
    if (me.hasServer && !localOnly) {
      // Bloed korrektion: traek lokal position mod serverens uden at rykke haardt.
      const t = 1 - Math.exp(-dt * PREDICT_BLEND);
      localPos.x += (me.serverPos.x - localPos.x) * t;
      localPos.z += (me.serverPos.z - localPos.z) * t;
      // y styres lokalt for et responsivt hop.
      // Blend kan traekke ind i en vaeg (serveren laver ikke collision endnu) - skub ud igen.
      resolveCollisions(localPos);
    }
    me.group.position.set(localPos.x, localPos.y, localPos.z);
    // Vend figuren efter FART-retningen (glatter end raa input, der vipper haardt).
    // Staar man stille, beholdes nuvaerende retning (ingen rykvis snap mod kamera).
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 0.35) {
      const faceYaw = Math.atan2(vel.x, vel.z);
      me.group.rotation.y = lerpAngle(me.group.rotation.y, faceYaw, 1 - Math.exp(-dt * 12));
    }
    // Roblox-agtig animations-state: idle/walk/run/jump/fald.
    let mstate;
    if (!onGround) mstate = (localVelY > 0.5) ? 'jump' : 'fall';
    else if (speed > MOVE_SPEED * 0.55) mstate = 'run';
    else if (speed > 0.4) mstate = 'walk';
    else mstate = 'idle';
    applyAvatarPose(me.group, { state: mstate, speed, t: now, dt });
  }

  // 4) Interpoler alle andre spillere mellem snapshots + animer deres gangcyklus.
  for (const [id, a] of avatars) {
    if (id === selfId) continue;
    const span = Math.max(0.02, a.snapDur);
    const alpha = Math.min(1, (now - a.snapTime) / span);
    a.group.position.lerpVectors(a.prev, a.target, alpha);
    a.group.rotation.y = lerpAngle(a.prevYaw, a.targetYaw, alpha);
    // Estimer fart ud fra positions-aendringen for at drive deres animation.
    if (!a._lastPos) a._lastPos = a.group.position.clone();
    const rspeed = Math.hypot(a.group.position.x - a._lastPos.x, a.group.position.z - a._lastPos.z) / Math.max(0.0001, dt);
    const rvy = (a._lastY != null) ? (a.group.position.y - a._lastY) / Math.max(0.0001, dt) : 0;
    a._lastY = a.group.position.y;
    a._lastPos.copy(a.group.position);
    // Roblox-agtig state for fjernspillere ud fra fart + lodret bevaegelse.
    let rstate;
    if (a.group.position.y > 0.15 && Math.abs(rvy) > 0.6) rstate = (rvy > 0) ? 'jump' : 'fall';
    else if (rspeed > MOVE_SPEED * 0.55) rstate = 'run';
    else if (rspeed > 0.4) rstate = 'walk';
    else rstate = 'idle';
    applyAvatarPose(a.group, { state: rstate, speed: rspeed, t: now, dt });
  }

  // 5) Kamera foelger egen spiller.
  if (me) controls.updateCamera(me.group.position, dt);

  // 5b) Svaevende roterende logo-baggrund (det Nico elskede) - drej + bob blidt.
  for (let i = 0; i < BG_GLYPHS.length; i++) {
    const g = BG_GLYPHS[i]; const u = g.userData || {};
    const spin = (u.spin != null ? u.spin : 0.25);
    g.rotation.y += spin * dt;
    g.rotation.z += spin * 0.35 * dt;
    if (u.baseY != null) g.position.y = u.baseY + Math.sin(now * 0.5 + (u.phase || i)) * 0.7;
  }

  // 5c) Orbs: blidt bob + spin saa de er tydelige collectibles.
  for (const m of orbMeshes.values()) {
    const by = (m.userData && m.userData.baseY != null) ? m.userData.baseY : m.position.y;
    m.position.y = by + Math.sin(now * 2 + m.position.x) * 0.18;
    m.rotation.y += dt * 1.6;
  }

  // 5d) Time Bomb: placer bombe-markoer over holderen + danger-ring under.
  ensureBombVisuals();
  const holder = bombHolderId ? avatars.get(bombHolderId) : null;
  if (holder) {
    const hp = holder.group.position;
    bombMarker.visible = true; holderRing.visible = true;
    bombMarker.position.set(hp.x, hp.y + 2.5 + Math.sin(now * 3) * 0.08, hp.z);
    bombMarker.rotation.y += dt * 1.2;
    holderRing.position.set(hp.x, hp.y + 0.05, hp.z);
    holderRing.rotation.y += dt * 0.8;
  } else {
    bombMarker.visible = false; holderRing.visible = false;
  }

  // 6) Render.
  renderer.render(scene, camera);

  // 7) Projicer navneskilte til skaerm-koordinater.
  updateNametags();

  // 8) Opdater HUD-stats (let throttlet).
  updateHud(dt);

  if (!booted) { booted = true; hideBoot(); }
}

// Robust loop-wrapper: een frame-fejl maa ALDRIG draebe hele render-loopet.
// Vi planlaegger altid naeste frame FOERST, og fanger fejl saa de logges een gang
// i stedet for at stoppe alt (det var praecis det der frøs scenen + HUD).
function tick(nowMs) {
  requestAnimationFrame(tick);
  try {
    tickBody(nowMs);
  } catch (e) {
    if (!window.__tickErr) {
      window.__tickErr = String((e && e.stack) || e);
      console.error('NovaVerse tick error:', e);
    }
  }
}

// Korteste-vej vinkel-lerp (undgaar spring ved +-PI).
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// --- Avatar-animation: gangcyklus + idle ----------------------------------
// Svinger ben (fra hoften) og arme (fra skulderen) kontralateralt efter fart,
// med et let lodret bob pr. skridt. Naar figuren staar stille, gaar den over i
// en blod idle-vejrtraekning. Drives af en glattet fart saa der ikke ryster.
// Bemaerk: group.position saettes fuldt hver frame FOER dette kald (self via .set,
// fjernspillere via lerpVectors), saa bob lagt ovenpaa ikke akkumulerer.
function animateAvatar(a, speed, t, dt) {
  const parts = a.group.userData.parts;
  if (!parts) return;
  // Glat farten, ellers ryster animationen ved smaa udsving.
  a.animSpeed = (a.animSpeed || 0);
  a.animSpeed += (speed - a.animSpeed) * (1 - Math.exp(-dt * 9));
  const walk = Math.min(1, a.animSpeed / MOVE_SPEED);
  // Skridt-frekvens stiger en anelse med farten.
  a.animPhase = (a.animPhase || 0) + dt * (6.5 + a.animSpeed * 1.5);
  const s = Math.sin(a.animPhase);
  const legAmp = 0.9 * walk;
  const armAmp = 0.62 * walk;
  const idle = 1 - walk;
  const idleSway = Math.sin(t * 1.7) * 0.06 * idle; // blod arm-bevaegelse naar stille

  // Ben svinger modsat hinanden; arme modsat benene (naturlig gang).
  if (parts.leftLeg)  parts.leftLeg.rotation.x  =  s * legAmp;
  if (parts.rightLeg) parts.rightLeg.rotation.x = -s * legAmp;
  // Let ankel-modrotation saa foden lander fladere.
  if (parts.leftFoot)  parts.leftFoot.rotation.x  = -s * legAmp * 0.35;
  if (parts.rightFoot) parts.rightFoot.rotation.x =  s * legAmp * 0.35;
  if (parts.leftArm)  parts.leftArm.rotation.x  = -s * armAmp + idleSway;
  if (parts.rightArm) parts.rightArm.rotation.x =  s * armAmp - idleSway;

  // Lodret bob: 2 skridt pr. fase-cyklus under gang + blid idle-aanding.
  const bob = Math.abs(s) * 0.07 * walk + Math.sin(t * 1.7) * 0.012 * idle;
  a.group.position.y += bob;
}

// --- Navneskilte: projicer hver figurs hoved til 2D og placer HTML-pillen ---
const _proj = new THREE.Vector3();
function updateNametags() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const [id, a] of avatars) {
    if (!a.tag) continue;
    // Egen figur har intet navneskilt (kameraet sidder bag dig).
    if (id === selfId) { a.tag.style.display = 'none'; continue; }
    // Hoved-position ~ 2.15 enheder over fod-origin.
    _proj.set(a.group.position.x, a.group.position.y + 2.15, a.group.position.z);
    _proj.project(camera);
    // Bag kameraet -> skjul.
    if (_proj.z > 1) { a.tag.style.display = 'none'; continue; }
    a.tag.style.display = '';
    const sx = (_proj.x * 0.5 + 0.5) * w;
    const sy = (-_proj.y * 0.5 + 0.5) * h;
    a.tag.style.left = sx + 'px';
    a.tag.style.top = sy + 'px';
  }
}

// --- HUD-opdatering ---
let hudAccum = 0;
function updateHud(dt) {
  hudAccum += dt;
  if (hudAccum < 0.12) return; // ~8 Hz; tabular-tal hopper ikke
  hudAccum = 0;

  // "live" = vi har modtaget en server-state for nylig. Det er den SANDE
  // multiplayer-indikator (robust mod kortvarige socket-genforbindelser, hvor
  // _connected-flaget kan blinke selvom data stadig flyder).
  const live = (performance.now() - lastStateAt) < 1500;

  // Spillertal: server-snapshot naar live, ellers antal figurer i scenen.
  const count = live ? Math.max(1, lastSnapshotPlayers) : (avatars.size || 1);
  elStatPlayers.textContent = String(count);

  if (live) {
    const p = net.ping;
    elStatPing.textContent = p > 0 ? String(p) : '...';
    setPingClass(p);
    setConn('is-ok');
  } else if (localOnly) {
    elStatPing.textContent = 'lokal';
    elStatPing.className = 'stat-value is-warn';
    setConn('is-warn');
  } else {
    elStatPing.textContent = '...';
    elStatPing.className = 'stat-value is-warn';
    setConn('is-warn');
  }
}

function setPingClass(p) {
  let cls = 'is-ok';
  if (p > 120) cls = 'is-danger';
  else if (p > 60) cls = 'is-warn';
  elStatPing.className = 'stat-value ' + cls;
}

function setConn(cls) {
  elConnDot.className = 'conn-dot ' + cls;
}

// --- Resize ---
window.addEventListener('resize', () => { if (resize) resize(); });

// --- Boot overlay haandtering ---
function hideBoot() {
  if (boot) boot.classList.add('hidden');
}
function bootFail(text) {
  if (bootText) bootText.textContent = text;
  if (boot) boot.classList.remove('hidden');
}

// Hex -> rgba helper til glow.
function hexToRgba(hex, a) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return `rgba(124,92,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Dev-test-hook (kun ?dev=1): tillader manuelt at steppe loopet og laese tilstand,
// saa bevaegelse + animation kan verificeres i en baggrundsfane hvor rAF er pauset.
if (DEV) {
  window.__nv = {
    tickBody,
    setMove(forward) {
      window.dispatchEvent(new KeyboardEvent(forward ? 'keydown' : 'keyup', { code: 'KeyW' }));
    },
    parts() { const me = avatars.get(selfId); return me && me.group.userData.parts; },
    selfPos() { return [localPos.x, localPos.y, localPos.z]; },
    vel() { return [vel.x, vel.z]; },
    limbRot() {
      const p = this.parts(); if (!p) return null;
      return { leftLeg: p.leftLeg.rotation.x, rightLeg: p.rightLeg.rotation.x, leftArm: p.leftArm.rotation.x, rightArm: p.rightArm.rotation.x };
    },
    selfId() { return selfId; },
  };
}

// Start loopet.
requestAnimationFrame(tick);

// Sikkerheds-net: skjul boot-overlayet selv hvis rAF skulle vaere throttlet
// (fx baggrundsfane) - vi renderer mindst een gang og fjerner loaderen.
setTimeout(() => {
  if (!booted) {
    try { renderer.render(scene, camera); } catch (e) { /* ignore */ }
    booted = true;
    hideBoot();
  }
}, 600);
