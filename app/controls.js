// controls.js
// Third-person follow camera + input controller for NovaVerse.
// Implementeret fra bunden uden OrbitControls. Kun kerne-THREE.
//
// Brug: const controls = createControls(camera, canvas);
//   - kald controls.update(dt) hver frame for at glatte yaw/pitch
//   - kald controls.updateCamera(playerPos, dt) for at lade kameraet traile spilleren
//   - laes controls.getMoveDir() for en world-space [x, z] bevaegelsesvektor
//   - laes controls.getYaw() til at sende over netvaerket
//   - laes controls.consumeJump() for et engangs-hop-flag

import * as THREE from 'three';

// Konfiguration for kameraet og foelelsen. Holdt samlet saa det er nemt at tune.
const CONFIG = {
  // Standard kamera-afstand (afstand langs kig-retningen). Roblox-agtig tredjeperson.
  distance: 6.5,
  // Zoom-graenser via scroll-hjul: naer (taet tredjeperson) til fjern.
  minDistance: 2.2,
  maxDistance: 11,
  // Hvor meget eet scroll-"notch" aendrer maal-afstanden. Skaleres proportionalt
  // med afstanden (som Roblox) saa hjulet foeles ens i hele intervallet.
  zoomStep: 0.9,
  // Glatnings-styrke for zoom-afstanden (hoejere = snappere). 1-exp(-dt*k).
  zoomSmoothing: 12,
  // Hoejde over spilleren som kameraet sigter mod (kig-punktet).
  lookHeight: 1.6,
  // Hvor hurtigt musen drejer yaw/pitch (radianer pr. pixel). Roblox ~0.0087 yaw.
  mouseSensitivity: 0.0075,
  // Glatnings-styrke for yaw/pitch (hoejere = snappere). Bruges i 1-exp(-dt*k).
  lookSmoothing: 22,
  // Glatnings-styrke for kameraets position (hoejere = strammere trailing).
  cameraSmoothing: 11,
  // Pitch-grraenser i radianer: kig et stykke ned, og en del op.
  pitchMin: -0.9,
  pitchMax: 1.25,
  // Kameraet behandles som en lille kugle saa det ikke stikker gennem hjoerner.
  cameraRadius: 0.3,
  // Lille luft mellem kamera og vaeg naar det traekkes ind (hold dig foran vaeggen).
  collisionSkin: 0.3,
};

export function createControls(camera, domElement, opts = {}) {
  // --- Look-state (yaw/pitch) ---
  // target* er hvad input sigter mod; de glatte vaerdier trailes hen mod dem.
  let targetYaw = 0;
  let targetPitch = 0.15; // start en anelse over horisonten
  let yaw = targetYaw;
  let pitch = targetPitch;

  // --- Zoom-state (scroll-hjul) ---
  // targetDistance er hvor langt vaek hjulet sigter; distance trailes derhen.
  let targetDistance = CONFIG.distance;
  let distance = CONFIG.distance;

  // --- Colliders (kamera-kollision) ---
  // Samme form som spillets world.colliders:
  //   {type:'box', min:[x,y,z], max:[x,y,z]} | {type:'cylinder', x, z, r, h}
  // Kan gives via opts.colliders eller saettes senere med setColliders().
  let colliders = Array.isArray(opts.colliders) ? opts.colliders : [];

  // --- Pointer lock / drag fallback ---
  let pointerLocked = false;
  let dragging = false; // bruges kun naar pointer lock ikke er tilgaengeligt

  // --- Tastatur-state ---
  // Vi holder styr paa hver bevaegelsestast separat (WASD + piletaster som alias).
  const keys = { forward: false, back: false, left: false, right: false };
  let jumpQueued = false; // saettes ved tastetryk, ryddes af consumeJump()

  // Genbrugte vektorer saa vi ikke allokerer i loopet (undgaar GC-jitter).
  const _moveDir = new THREE.Vector3();
  const _desiredCamPos = new THREE.Vector3();
  const _lookTarget = new THREE.Vector3();
  const _offset = new THREE.Vector3();
  const _camDir = new THREE.Vector3(); // enheds-retning fra kig-punkt mod kamera

  // Klampning af pitch til det tilladte interval.
  function clampPitch(p) {
    return THREE.MathUtils.clamp(p, CONFIG.pitchMin, CONFIG.pitchMax);
  }

  // Anvend en muse-delta paa target yaw/pitch.
  // Yaw er fri 360 grader; pitch klampes.
  function applyLookDelta(dx, dy) {
    targetYaw -= dx * CONFIG.mouseSensitivity;
    targetPitch = clampPitch(targetPitch - dy * CONFIG.mouseSensitivity);
  }

  // --- Pointer Lock haandtering ---
  // Klik paa canvas beder om pointer lock. Mens laast driver mousemove kiggeriet.
  function onClick() {
    if (!pointerLocked && domElement.requestPointerLock) {
      // requestPointerLock kan fejle/afvises; vi falder tilbage til drag i onMouseDown.
      domElement.requestPointerLock();
    }
  }

  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === domElement;
  }

  function onMouseMove(e) {
    if (pointerLocked) {
      // movementX/Y er raa pixel-deltas fra pointer lock.
      applyLookDelta(e.movementX || 0, e.movementY || 0);
    } else if (dragging) {
      // Fallback: traek-for-at-kigge naar pointer lock ikke er aktivt.
      applyLookDelta(e.movementX || 0, e.movementY || 0);
    }
  }

  // Drag for at kigge. Hoejre-knap (button 2) orbiterer som i Roblox; venstre
  // (button 0) understoettes ogsaa. Kun relevant naar pointer lock ikke er aktivt.
  function onMouseDown(e) {
    if (!pointerLocked && (e.button === 0 || e.button === 2)) {
      dragging = true;
    }
  }

  function onMouseUp() {
    dragging = false;
  }

  // Undgaa browser-kontekstmenuen ved hoejre-drag-orbit.
  function onContextMenu(e) {
    e.preventDefault();
  }

  // Scroll-hjul: zoom kameraet ind/ud. Trinnet skaleres proportionalt med
  // afstanden (Roblox-agtigt) saa hjulet foeles ens i hele intervallet.
  function onWheel(e) {
    e.preventDefault();
    // Normaliser hjul-delta (deltaMode 0 = pixels, 1 = linjer) til "notches".
    const unit = e.deltaMode === 1 ? 1 : 1 / 100;
    const notches = e.deltaY * unit;
    // Trin proportionalt med nuvaerende maal-afstand.
    const step = CONFIG.zoomStep * (1 + targetDistance / CONFIG.maxDistance);
    targetDistance = THREE.MathUtils.clamp(
      targetDistance + notches * step,
      CONFIG.minDistance,
      CONFIG.maxDistance
    );
  }

  // --- Tastatur ---
  function setKey(code, down) {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        keys.forward = down;
        return true;
      case 'KeyS':
      case 'ArrowDown':
        keys.back = down;
        return true;
      case 'KeyA':
      case 'ArrowLeft':
        keys.left = down;
        return true;
      case 'KeyD':
      case 'ArrowRight':
        keys.right = down;
        return true;
      case 'Space':
        if (down) jumpQueued = true; // koe et hop ved tryk
        return true;
      default:
        return false;
    }
  }

  function onKeyDown(e) {
    const handled = setKey(e.code, true);
    // Forhindr at piletaster/space scroller siden.
    if (handled && (e.code.startsWith('Arrow') || e.code === 'Space')) {
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    const handled = setKey(e.code, false);
    if (handled && (e.code.startsWith('Arrow') || e.code === 'Space')) {
      e.preventDefault();
    }
  }

  // Tilfoej alle listeners.
  domElement.addEventListener('click', onClick);
  domElement.addEventListener('mousedown', onMouseDown);
  domElement.addEventListener('contextmenu', onContextMenu);
  // passive:false saa preventDefault virker og siden ikke scroller ved zoom.
  domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // --- Offentligt API ---

  // Engangs-hop: returnerer true hoejst een gang pr. tastetryk.
  function consumeJump() {
    if (jumpQueued) {
      jumpQueued = false;
      return true;
    }
    return false;
  }

  // Saet (eller ryd) colliders som kameraet skal undgaa at gaa igennem.
  // Samme form som world.colliders. Kald fra main.js efter oprettelse.
  function setColliders(arr) {
    colliders = Array.isArray(arr) ? arr : [];
  }

  // World-space bevaegelsesvektor [x, z], normaliseret, roteret efter kamera-yaw.
  // "W" bevaeger vaek fra kameraet (dvs. i kameraets fremad-retning paa jorden).
  function getMoveDir() {
    // Lokal input i kamera-rummet: x = strafe (hoejre+), z = fremad.
    let ix = 0;
    let iz = 0;
    if (keys.forward) iz += 1;
    if (keys.back) iz -= 1;
    if (keys.right) ix += 1;
    if (keys.left) ix -= 1;

    if (ix === 0 && iz === 0) return [0, 0];

    // Roter inputtet efter den glatte yaw til world-space.
    // Med yaw=0 peger fremad mod -Z (standard kamera-konvention).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Fremad-vektor paa jorden = (-sin, -cos); hoejre-vektor = (cos, -sin).
    const wx = ix * cos - iz * sin;
    const wz = -ix * sin - iz * cos;

    _moveDir.set(wx, 0, wz);
    if (_moveDir.lengthSq() > 0) _moveDir.normalize();
    return [_moveDir.x, _moveDir.z];
  }

  // Nuvaerende glatte yaw (radianer) til netvaerk/andre systemer.
  function getYaw() {
    return yaw;
  }

  // Avancer yaw/pitch- og zoom-glatningen. Kald hver frame foer updateCamera.
  function update(dt) {
    // Eksponentiel glatning der er frame-rate-uafhaengig: 1 - exp(-dt*k).
    const t = 1 - Math.exp(-dt * CONFIG.lookSmoothing);
    // Yaw kan vikle; vi interpolerer korteste vej for at undgaa spring ved +-PI.
    yaw += shortestAngleDelta(yaw, targetYaw) * t;
    pitch += (targetPitch - pitch) * t;
    // Glat zoom-afstanden hen mod maalet (sat af scroll-hjulet).
    const tz = 1 - Math.exp(-dt * CONFIG.zoomSmoothing);
    distance += (targetDistance - distance) * tz;
  }

  // Tredjepersons follow-kamera: sidder bag spilleren (modsat yaw), loeftet af pitch,
  // og sigter mod et punkt lidt over spillerens hoved. Position lerpes for blod trailing.
  // Hvis der er colliders mellem kig-punkt og kamera, traekkes kameraet ind foran vaeggen.
  function updateCamera(targetPos, dt) {
    // Kig-punkt: lidt over spillerens position.
    _lookTarget.set(targetPos.x, targetPos.y + CONFIG.lookHeight, targetPos.z);

    // Enheds-retning fra kig-punkt mod den oenskede kamera-position (bag + op).
    // Fremad (mod -Z ved yaw=0) = (-sin yaw, 0, -cos yaw); kameraet sidder modsat.
    const cosPitch = Math.cos(pitch);
    _camDir.set(
      Math.sin(yaw) * cosPitch,
      Math.sin(pitch),
      Math.cos(yaw) * cosPitch
    );
    // _camDir er allerede en enheds-vektor (|(sin·cos, sin, cos·cos)| = 1).

    // Find faktisk afstand: den glatte zoom-afstand, men traekket ind hvis en
    // vaeg er paa vejen. Ingen colliders -> bare den fulde afstand.
    const allowed = clampCameraDistance(
      _lookTarget,
      _camDir,
      distance,
      colliders,
      CONFIG.cameraRadius,
      CONFIG.collisionSkin
    );

    // Oenskede kamera-position = kig-punkt + retning * tilladt afstand.
    _offset.copy(_camDir).multiplyScalar(allowed);
    _desiredCamPos.copy(_lookTarget).add(_offset);

    // Lerp kameraets position hen mod oensket, frame-rate-uafhaengigt.
    const t = 1 - Math.exp(-dt * CONFIG.cameraSmoothing);
    camera.position.lerp(_desiredCamPos, t);

    // Kig altid direkte mod kig-punktet (ingen lerp her -> ingen rystelser).
    camera.lookAt(_lookTarget);
  }

  // Fjern alle listeners. Valgfrit, men paent ved unmount.
  function cleanup() {
    domElement.removeEventListener('click', onClick);
    domElement.removeEventListener('mousedown', onMouseDown);
    domElement.removeEventListener('contextmenu', onContextMenu);
    domElement.removeEventListener('wheel', onWheel);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (pointerLocked && document.exitPointerLock) document.exitPointerLock();
  }

  return {
    getMoveDir,
    getYaw,
    consumeJump,
    update,
    updateCamera,
    setColliders,
    cleanup,
    // Eksponer raa state til debugging/HUD (kun laesning).
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get jump() { return jumpQueued; },
  };
}

// Korteste vinkel-forskel fra a til b, normaliseret til (-PI, PI].
// Bruges saa yaw-glatningen ikke tager den lange vej rundt ved indpakning.
function shortestAngleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// --- Kamera-kollision -------------------------------------------------------
// Billig stråle-mod-collider: vi marcherer fra kig-punktet mod den oenskede
// kamera-position og finder den foerste vaeg paa vejen. Boksene/cylinderne er
// de samme som spillets world.colliders. Tal-only matematik, ingen allokering
// i loopet. Kameraet behandles som en lille kugle (cameraRadius) saa det ikke
// stikker gennem skarpe hjoerner.

// Stråle mod akse-justeret boks (allerede udvidet med kugle-radius).
// Returnerer indgangs-t i [0, maxDist], eller Infinity hvis intet traf.
// Hvis origin er inde i boksen -> 0 (kameraet er allerede i en vaeg).
function rayAABB(ox, oy, oz, dx, dy, dz, bx0, by0, bz0, bx1, by1, bz1, maxDist) {
  if (ox >= bx0 && ox <= bx1 && oy >= by0 && oy <= by1 && oz >= bz0 && oz <= bz1) return 0;

  let tmin = 0;
  let tmax = maxDist;

  if (dx !== 0) {
    const inv = 1 / dx;
    let t0 = (bx0 - ox) * inv;
    let t1 = (bx1 - ox) * inv;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return Infinity;
  } else if (ox < bx0 || ox > bx1) return Infinity;

  if (dy !== 0) {
    const inv = 1 / dy;
    let t0 = (by0 - oy) * inv;
    let t1 = (by1 - oy) * inv;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return Infinity;
  } else if (oy < by0 || oy > by1) return Infinity;

  if (dz !== 0) {
    const inv = 1 / dz;
    let t0 = (bz0 - oz) * inv;
    let t1 = (bz1 - oz) * inv;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return Infinity;
  } else if (oz < bz0 || oz > bz1) return Infinity;

  return tmin;
}

// Stråle mod lodret cylinder centreret i (cx, cz), radius r (allerede udvidet),
// hoejde y i [0, h]. Returnerer indgangs-t i [0, maxDist] eller Infinity.
// Origin inde i den faste cylinder -> 0.
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, h, maxDist) {
  const px = ox - cx;
  const pz = oz - cz;

  if (px * px + pz * pz <= r * r && oy >= 0 && oy <= h) return 0;

  const a = dx * dx + dz * dz;
  const b = 2 * (px * dx + pz * dz);
  const c = px * px + pz * pz - r * r;

  if (a === 0) return Infinity; // lodret stråle: rammer aldrig disken udefra

  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;

  const sq = Math.sqrt(disc);
  const inv2a = 1 / (2 * a);
  const tNear = (-b - sq) * inv2a;
  const tFar = (-b + sq) * inv2a;

  if (tNear >= 0 && tNear <= maxDist) {
    const y = oy + dy * tNear;
    if (y >= 0 && y <= h) return tNear;
  }
  if (tFar >= 0 && tFar <= maxDist) {
    const y = oy + dy * tFar;
    if (y >= 0 && y <= h) return tFar;
  }
  return Infinity;
}

// Find den tilladte afstand langs dir (enheds-vektor) fra lookTarget, klampet
// til [0, maxDist]. Traekker collisionSkin fra traefpunktet saa kameraet sidder
// lige foran vaeggen. Ingen colliders -> bare maxDist.
function clampCameraDistance(lookTarget, dir, maxDist, colliders, sphereR, skin) {
  if (!colliders || colliders.length === 0) return maxDist;

  const ox = lookTarget.x;
  const oy = lookTarget.y;
  const oz = lookTarget.z;
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;

  let best = maxDist;

  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i];
    let t;
    if (col.type === 'box') {
      const mn = col.min;
      const mx = col.max;
      t = rayAABB(
        ox, oy, oz, dx, dy, dz,
        mn[0] - sphereR, mn[1] - sphereR, mn[2] - sphereR,
        mx[0] + sphereR, mx[1] + sphereR, mx[2] + sphereR,
        maxDist
      );
    } else if (col.type === 'cylinder') {
      t = rayCylinder(ox, oy, oz, dx, dy, dz, col.x, col.z, col.r + sphereR, col.h, maxDist);
    } else {
      continue;
    }
    if (t < best) best = t;
    if (best === 0) return 0; // allerede inde i noget -> traek helt ind
  }

  best -= skin;
  return best < 0 ? 0 : best;
}
