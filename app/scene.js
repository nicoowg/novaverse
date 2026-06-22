// NovaVerse - 3D scene + Nova avatar (THREE r169, core only).
// createScene(canvas, theme) bygger en verden hvis udseende afhaenger af temaet,
// saa hvert spil har sin egen map. theme er valgfri (default = Nova Hub-auroraen).
//
// Public contracts (other files depend on these EXACTLY):
//   export function createScene(canvas, theme)
//     -> { scene, camera, renderer, floor, resize, theme, colliders }
//        (colliders: array of { type:'box', min, max } | { type:'cylinder', x, z, r, h })
//        (scene.userData.bgGlyphs: array of drifting NOVA-glyph Groups)
//   export function makeNovaAvatar(color, opts)
//     -> THREE.Group with userData.parts =
//        { head, visor, leftArm, rightArm, leftLeg, rightLeg,
//          leftFoot, rightFoot, torso, chest }
//        (leftArm/rightArm/leftLeg/rightLeg are joint-pivot Groups).
import * as THREE from 'three';

const COLORS = { bgVoid: 0x07080d, bgBase: 0x0c0e16, bgRaised: 0x121525, violet: 0x7c5cff, indigo: 0x4d7cff, cyan: 0x38e1ff };

// Standard-tema (Nova Hub). Spil overrider felter via main.js' THEMES.
const DEFAULT_THEME = {
  top: '#0d0f19', mid: '#0a0b12', bot: '#07080d',
  fog: 0x07080d, floor: 0x161a2b,
  pillar: 0x1c2138, pillarEmissive: COLORS.indigo,
  accents: [COLORS.cyan, COLORS.violet, COLORS.indigo],
  variant: 'ring',
};

export function createScene(canvas, theme) {
  const T = Object.assign({}, DEFAULT_THEME, theme || {});

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.32;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = createVerticalGradientTexture(T.top, T.mid, T.bot);
  // Fog tuned a touch per-theme so each place has its own air.
  const fogNear = T.variant === 'caverns' ? 10 : 16;
  const fogFar = T.variant === 'caverns' ? 70 : 120;
  scene.fog = new THREE.Fog(T.fog, fogNear, fogFar);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 1, 0);

  addLights(scene, T);
  addAtmosphere(scene, T);
  const floor = createFloor(scene, T);
  const colliders = buildMap(scene, T);
  scene.userData.bgGlyphs = [];
  addNovaGlyphs(scene, T);

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  return { scene, camera, renderer, floor, resize, theme: T, colliders };
}

function createVerticalGradientTexture(top, mid, bot) {
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, top); grad.addColorStop(0.62, mid); grad.addColorStop(1.0, bot);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function addLights(scene, T) {
  const acc = (T && T.pillarEmissive != null) ? T.pillarEmissive : COLORS.indigo;
  scene.add(new THREE.HemisphereLight(0x6072b0, 0x14182a, 1.05));
  const key = new THREE.DirectionalLight(0xfff2dc, 2.6);
  key.position.set(8, 16, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const cam = key.shadow.camera;
  cam.left = -30; cam.right = 30; cam.top = 30; cam.bottom = -30; cam.near = 1; cam.far = 60;
  key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x5a7fc0, 0.7);
  fill.position.set(-10, 6, -8);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x2e3a60, 0.45));
  // A soft accent point light over the center to lift the lit-arena floor glow.
  const accent = new THREE.PointLight(acc, 0.9, 60, 1.6);
  accent.position.set(0, 7, 0);
  scene.add(accent);
}

// ===========================================================================
//  COLOR / TEXTURE UTILITIES (build-time only)
// ===========================================================================
function _hex(c) { return new THREE.Color(c); }                  // accepts int or css
function _css(c) { return _hex(c).getStyle(); }                  // -> 'rgb(...)' string
function _mix(a, b, t) { return _hex(a).clone().lerp(_hex(b), t); }
function _rgba(c, a) {
  const col = _hex(c);
  return `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
}

// Procedural floor map: radial center glow (lit-arena feel) fading to dark
// edges + subtle tile grid + faint noise speckle. Tinted per-theme.
function makeFloorTexture(opts = {}) {
  const {
    size = 1024,
    base = 0x0c0e16,
    glow = 0x7c5cff,
    mid = null,
    grid = 0x4d7cff,
    gridCells = 16,
    gridAlpha = 0.10,
    glowAlpha = 0.55,
    noiseAlpha = 0.05,
    vignette = 0.9,
  } = opts;

  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const midC = mid != null ? mid : _mix(base, glow, 0.35).getHex();

  // base fill
  ctx.fillStyle = _css(base);
  ctx.fillRect(0, 0, size, size);

  // radial accent glow center -> mid -> dark
  const rg = ctx.createRadialGradient(cx, cy, size * 0.02, cx, cy, size * 0.5);
  rg.addColorStop(0.0, _rgba(glow, glowAlpha));
  rg.addColorStop(0.18, _rgba(glow, glowAlpha * 0.55));
  rg.addColorStop(0.45, _rgba(midC, 0.18));
  rg.addColorStop(1.0, _rgba(base, 0.0));
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);

  // tile grid lines, fading toward edges
  const step = size / gridCells;
  ctx.lineWidth = Math.max(1, size / 1024);
  for (let i = 0; i <= gridCells; i++) {
    const p = i * step;
    const fadeV = 1.0 - Math.abs((p - cx) / cx) * 0.6;
    ctx.strokeStyle = _rgba(grid, gridAlpha * Math.max(0.15, fadeV));
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  // brighter pad rings near center (arena platform read)
  ctx.strokeStyle = _rgba(glow, 0.22);
  ctx.lineWidth = Math.max(2, size / 340);
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.165, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = _rgba(midC, 0.12);
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.30, 0, Math.PI * 2); ctx.stroke();

  // faint noise speckle for grain
  if (noiseAlpha > 0) {
    const dots = Math.floor(size * 1.6);
    for (let i = 0; i < dots; i++) {
      const x = Math.random() * size, y = Math.random() * size;
      const a = Math.random() * noiseAlpha;
      ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // vignette to sink edges into fog
  const vg = ctx.createRadialGradient(cx, cy, size * 0.28, cx, cy, size * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, `rgba(0,0,0,${vignette})`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Soft circular alpha falloff sprite, tinted; transparent edges for additive.
function makeRadialTexture(color = 0x7c5cff, opts = {}) {
  const { size = 256, inner = 1.0, falloff = 2.2 } = opts;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const cx = size / 2;
  const rg = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  rg.addColorStop(0.0, _rgba(color, inner));
  rg.addColorStop(0.25, _rgba(color, inner * 0.6));
  rg.addColorStop(0.6, _rgba(color, inner * 0.18 / falloff * 2));
  rg.addColorStop(1.0, _rgba(color, 0.0));
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
//  FLOOR  -> returns the floor Mesh (stored as `floor` by createScene)
// ===========================================================================
function createFloor(scene, T) {
  const SIZE = 200;
  const floorCol = _hex(T.floor != null ? T.floor : 0x0c0e16);
  const emiss = _hex(T.pillarEmissive != null ? T.pillarEmissive
    : (T.accents && T.accents[0]) != null ? T.accents[0] : 0x7c5cff);
  const accent = _hex((T.accents && T.accents[0]) != null ? T.accents[0] : emiss.getHex());

  // tiled grid + grain (repeats so cells stay small/sharp across 200u)
  const map = makeFloorTexture({
    base: floorCol.getHex(),
    glow: emiss.getHex(),
    grid: accent.getHex(),
    gridCells: 16,
    gridAlpha: 0.09,
    glowAlpha: 0.16,
    noiseAlpha: 0.045,
    vignette: 0.55,
  });
  map.repeat.set(10, 10);

  // single non-repeating radial that lights the arena center
  const centerGlow = makeFloorTexture({
    base: 0x000000,
    glow: emiss.getHex(),
    mid: _mix(emiss, accent, 0.5).getHex(),
    grid: accent.getHex(),
    gridCells: 8,
    gridAlpha: 0.05,
    glowAlpha: 0.5,
    noiseAlpha: 0.0,
    vignette: 0.0,
  });
  centerGlow.wrapS = centerGlow.wrapT = THREE.ClampToEdgeWrapping;
  centerGlow.repeat.set(1, 1);

  const mat = new THREE.MeshStandardMaterial({
    color: _mix(floorCol, 0x000000, 0.15),
    map,
    roughness: 0.62,
    metalness: 0.28,
    emissive: emiss.clone().multiplyScalar(0.9),
    emissiveMap: centerGlow,
    emissiveIntensity: 0.55,
    dithering: true,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE, 1, 1), mat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.position.y = 0;
  floor.name = 'floor';
  scene.add(floor);

  // faint additive neon grid overlay just above the plane
  const grid = new THREE.GridHelper(SIZE, 80,
    accent.clone().multiplyScalar(0.9),
    _mix(accent, floorCol, 0.6));
  grid.position.y = 0.012;
  const gm = grid.material;
  gm.transparent = true; gm.opacity = 0.10; gm.depthWrite = false;
  gm.blending = THREE.AdditiveBlending;
  grid.renderOrder = 1;
  floor.add(grid);

  // bright inner platform ring (arena focus)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(7.4, 7.7, 96),
    new THREE.MeshBasicMaterial({
      color: emiss.clone().lerp(_hex(0xffffff), 0.25),
      transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  ring.renderOrder = 2;
  floor.add(ring);

  return floor;
}

// ===========================================================================
//  ATMOSPHERE  -> depth: skydome gradient, aurora bands, distant silhouettes,
//                 horizon rings, far glints. Low poly, casts no shadow.
// ===========================================================================
function addAtmosphere(scene, T) {
  const group = new THREE.Group();
  group.name = 'atmosphere';

  const top = _hex(T.top || COLORS.bgBase);
  const mid = _hex(T.mid || COLORS.bgRaised);
  const bot = _hex(T.bot || COLORS.bgVoid);
  const accents = (T.accents && T.accents.length) ? T.accents
    : [T.pillarEmissive || COLORS.violet, COLORS.indigo, COLORS.cyan];
  const a0 = _hex(accents[0]);
  const a1 = _hex(accents[1 % accents.length]);
  const a2 = _hex(accents[2 % accents.length] || accents[0]);

  // gradient skydome (vertex-colored) on BackSide
  const domeGeo = new THREE.SphereGeometry(480, 32, 24);
  const pos = domeGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 480;
    if (y >= 0) c.copy(mid).lerp(top, y);
    else c.copy(mid).lerp(bot, -y);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: true,
  }));
  dome.renderOrder = -10;
  group.add(dome);

  // aurora bands far back (additive soft radials)
  const auroraTexA = makeRadialTexture(a0.getHex(), { size: 256, inner: 0.9, falloff: 2.6 });
  const auroraTexB = makeRadialTexture(a2.getHex(), { size: 256, inner: 0.9, falloff: 2.6 });
  const bandDefs = [
    { tex: auroraTexA, w: 320, h: 120, x: -40, y: 110, z: -300, rot: 0.18, op: 0.30 },
    { tex: auroraTexB, w: 260, h: 95, x: 90, y: 150, z: -340, rot: -0.22, op: 0.24 },
    { tex: auroraTexA, w: 200, h: 70, x: 10, y: 200, z: -380, rot: 0.05, op: 0.16 },
  ];
  for (const b of bandDefs) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(b.w, b.h),
      new THREE.MeshBasicMaterial({
        map: b.tex, transparent: true, opacity: b.op,
        blending: THREE.AdditiveBlending, depthWrite: false,
        fog: false, toneMapped: false, side: THREE.DoubleSide,
      })
    );
    m.position.set(b.x, b.y, b.z);
    m.rotation.z = b.rot;
    m.renderOrder = -8;
    group.add(m);
  }

  // distant silhouette rings on the horizon (structure depth)
  const ringTints = [_mix(a1, bot, 0.5), _mix(a0, bot, 0.6), _mix(a2, bot, 0.65)];
  for (let i = 0; i < 3; i++) {
    const r = 150 + i * 70;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r, r + 1.4 + i * 0.6, 128),
      new THREE.MeshBasicMaterial({
        color: ringTints[i], transparent: true, opacity: 0.10 - i * 0.022,
        blending: THREE.AdditiveBlending, depthWrite: false,
        fog: false, side: THREE.DoubleSide, toneMapped: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05 + i * 0.02;
    ring.renderOrder = -6;
    group.add(ring);
  }

  // low-poly distant monoliths on the horizon
  const siloMat = new THREE.MeshStandardMaterial({
    color: _mix(bot, 0x000000, 0.4), roughness: 1.0, metalness: 0.0,
    emissive: a0.clone().multiplyScalar(0.06),
  });
  const monoCount = 14;
  for (let i = 0; i < monoCount; i++) {
    const ang = (i / monoCount) * Math.PI * 2 + 0.3;
    const dist = 120 + (i % 3) * 28 + Math.random() * 30;
    const h = 22 + Math.random() * 60;
    const w = 6 + Math.random() * 10;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), siloMat);
    box.position.set(Math.cos(ang) * dist, h / 2 - 6, Math.sin(ang) * dist);
    box.rotation.y = Math.random() * Math.PI;
    box.castShadow = false; box.receiveShadow = false;
    group.add(box);

    if (i % 2 === 0) {
      const crown = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.02, 0.6, w * 1.02),
        new THREE.MeshBasicMaterial({
          color: (i % 4 === 0 ? a0 : a2).clone().lerp(_hex(0xffffff), 0.2),
          transparent: true, opacity: 0.5, toneMapped: false,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
        })
      );
      crown.position.set(box.position.x, h - 6, box.position.z);
      group.add(crown);
    }
  }

  // far-off glints scattered high
  const glintTex = makeRadialTexture(0xffffff, { size: 64, inner: 1.0, falloff: 1.6 });
  const glintCount = 60;
  const gGeo = new THREE.BufferGeometry();
  const gPos = new Float32Array(glintCount * 3);
  for (let i = 0; i < glintCount; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 140 + Math.random() * 280;
    gPos[i * 3] = Math.cos(ang) * dist;
    gPos[i * 3 + 1] = 12 + Math.random() * 220;
    gPos[i * 3 + 2] = Math.sin(ang) * dist - 40;
  }
  gGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  const glints = new THREE.Points(gGeo, new THREE.PointsMaterial({
    size: 3.2, map: glintTex, transparent: true,
    color: _mix(a2, 0xffffff, 0.4), opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
    sizeAttenuation: true, fog: false, toneMapped: false,
  }));
  glints.renderOrder = -5;
  group.add(glints);

  group.traverse((o) => { if (o.isMesh || o.isPoints) o.castShadow = false; });
  scene.add(group);
  return group;
}

// ===========================================================================
//  MAP BUILDER: forskellig layout pr. tema-variant
// ===========================================================================
function buildMap(scene, T) {
  const colliders = [];
  switch (T.variant) {
    case 'arena': arenaMap(scene, T, colliders); break;        // Time Bomb
    case 'platforms': platformsMap(scene, T, colliders); break; // Sky Parkour
    case 'open': openMap(scene, T, colliders); break;           // Tag Arena
    case 'track': trackMap(scene, T, colliders); break;         // Nova Drift
    case 'caverns': cavernsMap(scene, T, colliders); break;     // Crystal Caves
    case 'city': cityMap(scene, T, colliders); break;           // Neon City
    case 'garden': gardenMap(scene, T, colliders); break;       // Sky Garden
    case 'ring':
    default: ringMap(scene, T, colliders);                      // Nova Hub
  }
  floatingAccents(scene, T.accents);  // decorative motes only; no colliders
  return colliders;
}

function pillarMat(T) {
  return new THREE.MeshStandardMaterial({
    color: T.pillar, emissive: T.pillarEmissive, emissiveIntensity: 0.34,
    roughness: 0.6, metalness: 0.25,
  });
}

// flat emissive trim material (reads as a glowing edge)
function trimMat(hex, intensity = 1.0) {
  return new THREE.MeshStandardMaterial({
    color: 0x05060b, emissive: hex, emissiveIntensity: intensity,
    roughness: 0.4, metalness: 0.0,
  });
}

function accentOf(accents, i) {
  if (!accents || !accents.length) return COLORS.cyan;
  return accents[i % accents.length];
}

// a glowing disc platform (cylinder body + emissive rim ring on top)
function discPlatform(radius, height, bodyMat, rimMat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.96, height, 48), bodyMat);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.98, height * 0.16, 10, 64), rimMat);
  rim.rotation.x = Math.PI / 2; rim.position.y = height / 2;
  g.add(rim);
  return g;
}

// ---- RING (Nova Hub): ring of tall pillars around a central plaza ---------
function ringMap(scene, T, colliders) {
  const grp = new THREE.Group();
  const pMat = pillarMat(T);

  // raised central plaza disc (grounded)
  colliders.push({ type: 'cylinder', x: 0, z: 0, r: 7.4, h: 0.5 });

  const plazaMat = new THREE.MeshStandardMaterial({
    color: T.floor, roughness: 0.7, metalness: 0.2,
    emissive: accentOf(T.accents, 0), emissiveIntensity: 0.05,
  });
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.5, 64), plazaMat);
  plaza.position.y = 0.25; plaza.receiveShadow = true;
  grp.add(plaza);

  const inlay = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.09, 8, 96), trimMat(accentOf(T.accents, 1), 1.1));
  inlay.rotation.x = Math.PI / 2; inlay.position.y = 0.52;
  grp.add(inlay);

  const count = 12;
  const radius = 13;
  const shaftGeo = new THREE.BoxGeometry(1.1, 9, 1.1);
  const baseGeo = new THREE.BoxGeometry(1.7, 0.6, 1.7);
  const capGeo = new THREE.BoxGeometry(1.4, 0.45, 1.4);
  const capMat = trimMat(T.pillarEmissive, 1.4);
  const bannerGeo = new THREE.PlaneGeometry(0.9, 4);

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;

    // pillar collider: covers base (1.7 wide) + shaft up to cap top
    colliders.push({ type: 'cylinder', x, z, r: 0.85, h: 10.0 });

    const base = new THREE.Mesh(baseGeo, pMat);
    base.position.set(x, 0.3, z); base.castShadow = true; base.receiveShadow = true;
    grp.add(base);

    const shaft = new THREE.Mesh(shaftGeo, pMat);
    shaft.position.set(x, 5.1, z); shaft.castShadow = true;
    grp.add(shaft);

    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(x, 9.8, z); cap.castShadow = true;
    grp.add(cap);

    const banner = new THREE.Mesh(bannerGeo, new THREE.MeshStandardMaterial({
      color: 0x0a0c14, emissive: accentOf(T.accents, i), emissiveIntensity: 0.7,
      roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide,
    }));
    banner.position.set(x * 0.86, 6.5, z * 0.86);
    banner.lookAt(0, 6.5, 0);
    grp.add(banner);
  }

  scene.add(grp);
}

// ---- ARENA (Time Bomb): ring wall + seating tiers + central glowing dais --
function arenaMap(scene, T, colliders) {
  const grp = new THREE.Group();
  const pMat = pillarMat(T);

  const floorMat = new THREE.MeshStandardMaterial({ color: T.floor, roughness: 0.75, metalness: 0.15 });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 0.4, 64), floorMat);
  floor.position.y = 0.2; floor.receiveShadow = true;
  grp.add(floor);

  const ground = new THREE.Mesh(new THREE.TorusGeometry(10.5, 0.08, 8, 96), trimMat(accentOf(T.accents, 0), 1.0));
  ground.rotation.x = Math.PI / 2; ground.position.y = 0.42;
  grp.add(ground);

  const wallSeg = 28, wallR = 12.2;
  const wallGeo = new THREE.BoxGeometry(2.9, 1.6, 0.9);
  const wallCapMat = trimMat(T.pillarEmissive, 1.1);
  const wallCapGeo = new THREE.BoxGeometry(2.95, 0.16, 0.95);
  for (let i = 0; i < wallSeg; i++) {
    const a = (i / wallSeg) * Math.PI * 2;
    const x = Math.cos(a) * wallR, z = Math.sin(a) * wallR;
    // ring-wall segment (rotated box approximated by upright cylinder; segments overlap into a wall)
    colliders.push({ type: 'cylinder', x, z, r: 1.0, h: 1.6 });
    const seg = new THREE.Mesh(wallGeo, pMat);
    seg.position.set(x, 0.8, z); seg.rotation.y = -a; seg.castShadow = true; seg.receiveShadow = true;
    grp.add(seg);
    const cap = new THREE.Mesh(wallCapGeo, wallCapMat);
    cap.position.set(x, 1.66, z); cap.rotation.y = -a;
    grp.add(cap);
  }

  const tierMat = new THREE.MeshStandardMaterial({
    color: T.pillar, roughness: 0.8, metalness: 0.1,
    emissive: T.pillarEmissive, emissiveIntensity: 0.12, side: THREE.DoubleSide,
  });
  [[13.6, 0.9, 2.2], [15.2, 1.9, 2.0]].forEach(([r, y, h]) => {
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r + 1, r, h, 64, 1, true), tierMat);
    tier.position.y = y; tier.receiveShadow = true;
    grp.add(tier);
  });

  const lightGeo = new THREE.SphereGeometry(0.16, 10, 10);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const l = new THREE.Mesh(lightGeo, trimMat(accentOf(T.accents, i), 1.6));
    l.position.set(Math.cos(a) * 12.4, 2.0, Math.sin(a) * 12.4);
    grp.add(l);
  }

  // central dais / pedestal for the bomb (glowing)
  const dais = new THREE.Group();
  let yAcc = 0;
  [[2.6, 0.5], [2.0, 0.5], [1.4, 0.6]].forEach(([r, h]) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.25, h, 48), pMat);
    m.position.y = yAcc + h / 2; m.castShadow = true; m.receiveShadow = true;
    dais.add(m);
    yAcc += h;
  });
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.3, 32), trimMat(accentOf(T.accents, 0), 2.0));
  ped.position.y = yAcc + 0.15;
  dais.add(ped);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.07, 8, 48), trimMat(accentOf(T.accents, 1), 1.8));
  halo.rotation.x = Math.PI / 2; halo.position.y = yAcc + 0.05;
  dais.add(halo);
  grp.add(dais);
  // central dais (stack at origin, base@0): enclose full footprint + pedestal
  colliders.push({ type: 'cylinder', x: 0, z: 0, r: 2.6, h: 1.9 });

  scene.add(grp);
}

// ---- PLATFORMS (Sky Parkour): floating jump platforms leading away (z<0) --
function platformsMap(scene, T, colliders) {
  const grp = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: T.floor, roughness: 0.65, metalness: 0.25,
    emissive: T.pillarEmissive, emissiveIntensity: 0.08,
  });

  const steps = 9;
  let prev = null;
  for (let i = 0; i < steps; i++) {
    const z = -i * 7 - 2;
    const x = Math.sin(i * 1.1) * 6;
    const y = 1.2 + Math.sin(i * 0.8) * 1.4 + i * 0.25;
    const r = 2.6 - i * 0.05;

    const plat = discPlatform(r, 0.55, bodyMat, trimMat(accentOf(T.accents, i), 1.3));
    plat.position.set(x, y, z);
    grp.add(plat);
    // floating parkour platform (body height 0.55, centered on y)
    colliders.push({ type: 'box', min: [x - r, y - 0.275, z - r], max: [x + r, y + 0.275, z + r] });

    const postMat = trimMat(accentOf(T.accents, i + 1), 1.5);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.18), postMat);
      post.position.set(x + Math.cos(a) * r * 0.7, y + 0.5, z + Math.sin(a) * r * 0.7);
      grp.add(post);
    }

    if (prev) {
      const beamMat = trimMat(accentOf(T.accents, i), 0.7);
      const dx = x - prev.x, dy = y - prev.y, dz = z - prev.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 6), beamMat);
      beam.position.set((x + prev.x) / 2, (y + prev.y) / 2, (z + prev.z) / 2);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
      grp.add(beam);
    }
    prev = { x, y, z };
  }

  scene.add(grp);
}

// ---- OPEN (Tag Arena): open field with scattered low cover blocks ---------
function openMap(scene, T, colliders) {
  const grp = new THREE.Group();
  const pMat = pillarMat(T);

  const field = new THREE.Mesh(new THREE.BoxGeometry(40, 0.4, 40),
    new THREE.MeshStandardMaterial({ color: T.floor, roughness: 0.85, metalness: 0.1 }));
  field.position.y = 0.2; field.receiveShadow = true;
  grp.add(field);

  const barMat = trimMat(accentOf(T.accents, 0), 0.8);
  [[0, 19, 38, 0.4], [0, -19, 38, 0.4], [19, 0, 0.4, 38], [-19, 0, 0.4, 38]]
    .forEach(([bx, bz, bw, bd]) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.14, bd), barMat);
      bar.position.set(bx, 0.43, bz);
      grp.add(bar);
    });

  const placements = 16;
  for (let i = 0; i < placements; i++) {
    const x = (Math.random() - 0.5) * 30;
    const z = (Math.random() - 0.5) * 30;
    if (Math.abs(x) < 4 && Math.abs(z) < 4) continue;

    const kind = i % 3;
    const stripeMat = trimMat(accentOf(T.accents, i), 1.2);
    const cover = new THREE.Group();

    if (kind === 0) {
      const w = 2.4 + Math.random() * 1.6, h = 1.3, d = 0.8;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), pMat);
      b.position.y = h / 2; b.castShadow = true; b.receiveShadow = true;
      cover.add(b);
      const s = new THREE.Mesh(new THREE.BoxGeometry(w * 1.01, 0.12, d * 1.01), stripeMat);
      s.position.y = h * 0.7; cover.add(s);
      // rotation-invariant cylinder enclosing the random-rotated box (base@0; +0.4 = field top)
      colliders.push({ type: 'cylinder', x, z, r: Math.hypot(w, d) / 2, h: h + 0.4 });
    } else if (kind === 1) {
      const sz = 1.4 + Math.random() * 0.6;
      const b = new THREE.Mesh(new THREE.BoxGeometry(sz, sz, sz), pMat);
      b.position.y = sz / 2; b.castShadow = true; b.receiveShadow = true;
      cover.add(b);
      const s = new THREE.Mesh(new THREE.BoxGeometry(sz * 1.02, 0.12, sz * 1.02), stripeMat);
      s.position.y = sz; cover.add(s);
      colliders.push({ type: 'cylinder', x, z, r: Math.hypot(sz, sz) / 2, h: sz + 0.4 });
    } else {
      const r = 0.9 + Math.random() * 0.4, h = 1.2;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), pMat);
      b.position.y = h / 2; b.castShadow = true; b.receiveShadow = true;
      cover.add(b);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.06, 6, 6), stripeMat);
      ring.rotation.x = Math.PI / 2; ring.position.y = h * 0.7;
      cover.add(ring);
      colliders.push({ type: 'cylinder', x, z, r, h: h + 0.4 });
    }

    cover.position.set(x, 0.4, z);
    cover.rotation.y = Math.random() * Math.PI;
    grp.add(cover);
  }

  scene.add(grp);
}

// ---- TRACK (Nova Drift): two neon rails + start gate + checkpoints + finish
function trackMap(scene, T, colliders) {
  const grp = new THREE.Group();
  const len = 70;
  const railGap = 5;

  const bed = new THREE.Mesh(new THREE.BoxGeometry(railGap + 3, 0.3, len),
    new THREE.MeshStandardMaterial({ color: T.floor, roughness: 0.8, metalness: 0.15 }));
  bed.position.set(0, 0.15, -len / 2 + 4); bed.receiveShadow = true;
  grp.add(bed);

  const railGeo = new THREE.BoxGeometry(0.5, 0.7, len);
  const railMat = trimMat(accentOf(T.accents, 0), 1.4);
  [-railGap / 2, railGap / 2].forEach((rx) => {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(rx, 0.55, -len / 2 + 4); rail.castShadow = true;
    grp.add(rail);
    // rail collider: full-length box (rail box 0.5 wide, 0.7 tall @ y0.55)
    colliders.push({ type: 'box',
      min: [rx - 0.25, 0.2, -len / 2 + 4 - len / 2],
      max: [rx + 0.25, 0.9, -len / 2 + 4 + len / 2] });
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, len), trimMat(accentOf(T.accents, 0), 0.5));
    glow.position.set(rx, 0.32, -len / 2 + 4);
    grp.add(glow);
  });

  const dashMat = trimMat(accentOf(T.accents, 1), 1.0);
  const dashGeo = new THREE.BoxGeometry(0.3, 0.05, 1.6);
  for (let i = 0; i < 22; i++) {
    const d = new THREE.Mesh(dashGeo, dashMat);
    d.position.set(0, 0.33, 4 - i * 3.2);
    grp.add(d);
  }

  const startGate = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.28, 14, 40), trimMat(accentOf(T.accents, 0), 1.8));
  startGate.position.set(0, 3.2, 4); startGate.castShadow = true;
  grp.add(startGate);

  const cpGeo = new THREE.TorusGeometry(3.0, 0.16, 12, 36);
  for (let i = 1; i <= 4; i++) {
    const cp = new THREE.Mesh(cpGeo, trimMat(accentOf(T.accents, i), 1.3));
    cp.position.set(0, 3.0, 4 - i * 13);
    grp.add(cp);
  }

  const finishZ = 4 - len + 6;
  const postMat = trimMat(accentOf(T.accents, 2), 1.6);
  [-railGap / 2 - 1, railGap / 2 + 1].forEach((px) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 0.4), postMat);
    post.position.set(px, 3, finishZ); post.castShadow = true;
    grp.add(post);
    // finish-line post (0.4 cube footprint, 6 tall @ y3)
    colliders.push({ type: 'box',
      min: [px - 0.2, 0, finishZ - 0.2],
      max: [px + 0.2, 6, finishZ + 0.2] });
  });
  const cellGeo = new THREE.BoxGeometry(0.9, 0.7, 0.2);
  for (let i = 0; i < 8; i++) {
    const on = i % 2 === 0;
    const cm = trimMat(on ? accentOf(T.accents, 0) : accentOf(T.accents, 1), on ? 1.6 : 0.9);
    const cell = new THREE.Mesh(cellGeo, cm);
    cell.position.set(-railGap / 2 - 0.5 + i * 0.95, 5.4, finishZ);
    grp.add(cell);
  }

  scene.add(grp);
}

// ---- CAVERNS (Crystal Caves): clustered emissive crystal spikes ----------
function cavernsMap(scene, T, colliders) {
  const grp = new THREE.Group();

  const rockMat = new THREE.MeshStandardMaterial({
    color: T.floor, roughness: 0.95, metalness: 0.05,
    emissive: 0x05060c, emissiveIntensity: 0.4,
  });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(20, 22, 1.2, 7), rockMat);
  floor.position.y = -0.3; floor.receiveShadow = true;
  grp.add(floor);

  const moundGeo = new THREE.IcosahedronGeometry(2.4, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const m = new THREE.Mesh(moundGeo, rockMat);
    m.position.set(Math.cos(a) * 13, 0.4, Math.sin(a) * 13);
    m.scale.set(1 + Math.random(), 0.5 + Math.random() * 0.4, 1 + Math.random());
    m.rotation.set(Math.random(), Math.random(), Math.random());
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
    // boulder mound footprint (icosa r2.4 * scaleX), squat
    colliders.push({ type: 'cylinder', x: m.position.x, z: m.position.z, r: 2.4 * m.scale.x, h: Math.max(1.2, 2.4 * m.scale.y) });
  }

  function crystalMat(hex, intensity) {
    return new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: intensity,
      roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.92, flatShading: true,
    });
  }

  const spikeBig = new THREE.ConeGeometry(0.9, 5.5, 6);
  const spikeMed = new THREE.ConeGeometry(0.5, 3.0, 5);
  const shardGeo = new THREE.OctahedronGeometry(0.55, 0);

  function crystalCluster(cx, cz, scale) {
    // cluster footprint (big cone 5.5 tall * scale; ring spread ~1.6*scale)
    colliders.push({ type: 'cylinder', x: cx, z: cz, r: 1.6 * scale, h: 5.5 * scale });
    const c = new THREE.Group();
    const accA = crystalMat(accentOf(T.accents, 0), 1.5);
    const accB = crystalMat(accentOf(T.accents, 1), 1.7);
    const accC = crystalMat(accentOf(T.accents, 2), 1.3);

    const big = new THREE.Mesh(spikeBig, accA);
    big.position.y = 2.6 * scale; big.scale.setScalar(scale);
    big.rotation.z = (Math.random() - 0.5) * 0.25; big.castShadow = true;
    c.add(big);

    const ring = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + Math.random() * 0.4;
      const r = (0.9 + Math.random() * 0.6) * scale;
      const s = (0.6 + Math.random() * 0.7) * scale;
      const sp = new THREE.Mesh(spikeMed, i % 2 ? accB : accC);
      sp.position.set(Math.cos(a) * r, 1.4 * s, Math.sin(a) * r);
      sp.scale.setScalar(s);
      sp.rotation.z = Math.cos(a) * 0.5;
      sp.rotation.x = -Math.sin(a) * 0.5;
      sp.castShadow = true;
      c.add(sp);
    }

    for (let i = 0; i < 5; i++) {
      const sh = new THREE.Mesh(shardGeo, i % 2 ? accA : accB);
      sh.position.set((Math.random() - 0.5) * 3 * scale, 0.4 + Math.random() * 2.4 * scale, (Math.random() - 0.5) * 3 * scale);
      sh.scale.setScalar((0.5 + Math.random()) * scale);
      sh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      c.add(sh);
    }

    c.position.set(cx, 0.2, cz);
    return c;
  }

  grp.add(crystalCluster(0, 0, 1.4));
  grp.add(crystalCluster(-7, -5, 1.0));
  grp.add(crystalCluster(8, 4, 1.1));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    grp.add(crystalCluster(Math.cos(a) * 11, Math.sin(a) * 11, 0.5 + Math.random() * 0.4));
  }

  const loneShard = new THREE.OctahedronGeometry(0.4, 0);
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(loneShard, crystalMat(accentOf(T.accents, i), 1.4));
    m.position.set((Math.random() - 0.5) * 32, 0.3 + Math.random() * 0.6, (Math.random() - 0.5) * 32);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.setScalar(0.4 + Math.random() * 0.5);
    grp.add(m);
  }

  scene.add(grp);
}

// ---- CITY (Neon City): skyline ring/grid of lit buildings + central plaza -
function cityMap(scene, T, colliders) {
  const grp = new THREE.Group();

  const plaza = new THREE.Mesh(new THREE.BoxGeometry(44, 0.4, 44),
    new THREE.MeshStandardMaterial({ color: T.floor, roughness: 0.7, metalness: 0.3 }));
  plaza.position.y = 0.2; plaza.receiveShadow = true;
  grp.add(plaza);

  const inlay = new THREE.Mesh(new THREE.TorusGeometry(5, 0.1, 8, 80), trimMat(accentOf(T.accents, 0), 1.1));
  inlay.rotation.x = Math.PI / 2; inlay.position.y = 0.42;
  grp.add(inlay);

  const bodyMats = [
    new THREE.MeshStandardMaterial({ color: COLORS.bgRaised, roughness: 0.55, metalness: 0.4 }),
    new THREE.MeshStandardMaterial({ color: T.pillar, roughness: 0.6, metalness: 0.35 }),
    new THREE.MeshStandardMaterial({ color: COLORS.bgBase, roughness: 0.65, metalness: 0.3 }),
  ];

  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x05060b, emissive: accentOf(T.accents, 0), emissiveIntensity: 1.3,
    roughness: 0.3, metalness: 0.0,
  });
  const windowGeo = new THREE.BoxGeometry(0.32, 0.55, 0.05);

  function building(x, z, w, h, d, accentI) {
    // building footprint (group y0.4 + body height h); axis-aligned, no rotation
    colliders.push({ type: 'box', min: [x - w / 2, 0, z - d / 2], max: [x + w / 2, 0.4 + h, z + d / 2] });
    const b = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMats[accentI % bodyMats.length]);
    body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
    b.add(body);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.22, d * 1.04), trimMat(accentOf(T.accents, accentI), 1.4));
    roof.position.y = h + 0.05;
    b.add(roof);

    const cols = Math.max(2, Math.floor(w / 1.1));
    const rows = Math.max(2, Math.floor(h / 1.3));
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        if (Math.random() < 0.32) continue;
        const wy = 0.9 + r * (h - 1.4) / Math.max(1, rows - 1);
        const wx = -w / 2 + 0.6 + cI * (w - 1.2) / Math.max(1, cols - 1);
        const wf = new THREE.Mesh(windowGeo, windowMat);
        wf.position.set(wx, wy, d / 2 + 0.01);
        b.add(wf);
        const ws = new THREE.Mesh(windowGeo, windowMat);
        ws.position.set(w / 2 + 0.01, wy, -d / 2 + 0.6 + cI * (d - 1.2) / Math.max(1, cols - 1));
        ws.rotation.y = Math.PI / 2;
        b.add(ws);
      }
    }

    b.position.set(x, 0.4, z);
    return b;
  }

  const slots = [
    ...Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return [Math.cos(a) * 9, Math.sin(a) * 9, 2.2, 4 + Math.random() * 3, 2.2];
    }),
    ...Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      return [Math.cos(a) * 16, Math.sin(a) * 16, 2.8, 7 + Math.random() * 7, 2.8];
    }),
  ];
  slots.forEach((s, i) => grp.add(building(s[0], s[1], s[2], s[3], s[4], i)));

  grp.add(building(-19, -19, 3.4, 16, 3.4, 0));
  grp.add(building(19, 18, 3.0, 13, 3.0, 1));

  scene.add(grp);
}

// ---- GARDEN (Sky Garden): floating platforms, stylized trees, clouds ------
function gardenMap(scene, T, colliders) {
  const grp = new THREE.Group();

  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x3fae7a, emissive: 0x1f6e4a, emissiveIntensity: 0.25,
    roughness: 0.7, metalness: 0.05, flatShading: true,
  });
  const leafMat2 = new THREE.MeshStandardMaterial({
    color: 0x6fd6a0, emissive: 0x2f8f63, emissiveIntensity: 0.3,
    roughness: 0.7, metalness: 0.05, flatShading: true,
  });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6f57, roughness: 0.85, metalness: 0.0 });
  const grassMat = new THREE.MeshStandardMaterial({
    color: T.floor, roughness: 0.8, metalness: 0.1,
    emissive: accentOf(T.accents, 0), emissiveIntensity: 0.06,
  });

  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 1.6, 8);
  const canopyGeo = new THREE.IcosahedronGeometry(1.0, 0);

  function tree(scale) {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.8 * scale; trunk.scale.setScalar(scale); trunk.castShadow = true;
    t.add(trunk);
    const blobs = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < blobs; i++) {
      const c = new THREE.Mesh(canopyGeo, i % 2 ? leafMat2 : leafMat);
      c.position.set((Math.random() - 0.5) * 0.8 * scale, (1.7 + Math.random() * 0.5) * scale, (Math.random() - 0.5) * 0.8 * scale);
      c.scale.setScalar((0.8 + Math.random() * 0.5) * scale); c.castShadow = true;
      t.add(c);
    }
    return t;
  }

  function gardenPlatform(r, accentI) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 0.7, 40), grassMat);
    top.receiveShadow = true; top.castShadow = true;
    g.add(top);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.96, 0.12, 8, 48), trimMat(accentOf(T.accents, accentI), 0.9));
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.35;
    g.add(rim);
    const under = new THREE.Mesh(new THREE.ConeGeometry(r * 0.85, 2.2, 24), grassMat);
    under.position.y = -1.4; under.receiveShadow = true;
    g.add(under);
    return g;
  }

  const center = gardenPlatform(6, 0);
  center.position.set(0, 0, 0);
  grp.add(center);
  // grounded central platform (top body straddles y0, h0.7)
  colliders.push({ type: 'cylinder', x: 0, z: 0, r: 6, h: 0.7 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const sc = 1.0 + Math.random() * 0.5;
    const tr = tree(sc);
    tr.position.set(Math.cos(a) * 3.2, 0.35, Math.sin(a) * 3.2);
    grp.add(tr);
    // tree trunk (thin) sitting on the central platform
    colliders.push({ type: 'box',
      min: [tr.position.x - 0.3 * sc, tr.position.y, tr.position.z - 0.3 * sc],
      max: [tr.position.x + 0.3 * sc, tr.position.y + 1.6 * sc, tr.position.z + 0.3 * sc] });
  }

  const sats = [
    [10, 1.5, -6, 3], [-9, 2.6, -4, 2.4], [6, 3.2, 9, 2.6],
    [-11, 1.0, 5, 2.8], [0, 4.0, -12, 2.2],
  ];
  sats.forEach(([x, y, z, r], i) => {
    const p = gardenPlatform(r, i + 1);
    p.position.set(x, y, z);
    grp.add(p);
    // floating garden platform (top body height 0.7, centered on y)
    colliders.push({ type: 'box', min: [x - r, y - 0.35, z - r], max: [x + r, y + 0.35, z + r] });
    const sc = 0.8 + Math.random() * 0.5;
    const tr = tree(sc);
    tr.position.set(x + (Math.random() - 0.5), y + 0.35, z + (Math.random() - 0.5));
    grp.add(tr);
    // tree trunk floating with its platform (box from trunk base upward)
    colliders.push({ type: 'box',
      min: [tr.position.x - 0.3 * sc, tr.position.y, tr.position.z - 0.3 * sc],
      max: [tr.position.x + 0.3 * sc, tr.position.y + 1.6 * sc, tr.position.z + 0.3 * sc] });
  });

  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xc9d6ff, emissive: 0x6f86c9, emissiveIntensity: 0.18,
    roughness: 1.0, metalness: 0.0, transparent: true, opacity: 0.5, flatShading: true,
  });
  const puffGeo = new THREE.IcosahedronGeometry(1.4, 0);
  for (let i = 0; i < 9; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 3);
      puff.scale.set(1 + Math.random(), 0.5, 1 + Math.random());
      cloud.add(puff);
    }
    const a = (i / 9) * Math.PI * 2;
    cloud.position.set(Math.cos(a) * (10 + Math.random() * 6), -4 - Math.random() * 3, Math.sin(a) * (10 + Math.random() * 6));
    grp.add(cloud);
  }

  const petalGeo = new THREE.PlaneGeometry(0.3, 0.4);
  for (let i = 0; i < 14; i++) {
    const petal = new THREE.Mesh(petalGeo, i % 2 ? leafMat2 : leafMat);
    petal.position.set((Math.random() - 0.5) * 24, 1 + Math.random() * 7, (Math.random() - 0.5) * 24);
    petal.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    petal.material.side = THREE.DoubleSide;
    grp.add(petal);
  }

  scene.add(grp);
}

// ---- FLOATING ACCENTS: small emissive icosahedron motes (~6-8) ------------
function floatingAccents(scene, accents) {
  const grp = new THREE.Group();
  const list = (accents && accents.length) ? accents : [COLORS.violet, COLORS.indigo, COLORS.cyan];

  const moteGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const placements = [
    [-10, 7, -8, 1.0], [9, 9, -6, 0.7], [-6, 11, 6, 0.85],
    [12, 6, 8, 0.6], [0, 13, -12, 0.9], [-13, 8, 2, 0.55],
    [6, 10, 12, 0.75], [3, 12, 4, 0.5],
  ];

  const n = 6 + Math.floor(Math.random() * 3); // 6..8
  for (let i = 0; i < n; i++) {
    const [x, y, z, s] = placements[i % placements.length];
    const hex = list[i % list.length];
    const mat = new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: 1.6,
      roughness: 0.3, metalness: 0.1, flatShading: true,
    });
    const mote = new THREE.Mesh(moteGeo, mat);
    mote.position.set(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2, z + (Math.random() - 0.5) * 2);
    mote.scale.setScalar(s);
    mote.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    grp.add(mote);

    if (i % 3 === 0) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.9 * s, 0.05, 6, 24),
        new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 1.0, roughness: 0.4 })
      );
      halo.position.copy(mote.position);
      halo.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      grp.add(halo);
    }
  }

  scene.add(grp);
}

// ===========================================================================
//  NOVA GLYPHS: slow-drifting 8-point burst stars, high/far, emissive.
//  Decorative ONLY (never colliders). Stored in scene.userData.bgGlyphs so the
//  external loop can rotate + bob each wrapper Group:
//     g.rotation.z += g.userData.spin * dt;
//     g.position.y  = g.userData.baseY + Math.sin(t * 0.5 + g.userData.phase) * 0.6;
// ===========================================================================
function addNovaGlyphs(scene, T) {
  if (!scene.userData.bgGlyphs) scene.userData.bgGlyphs = [];

  const accents = (T && T.accents && T.accents.length)
    ? T.accents
    : [COLORS.cyan, COLORS.violet, COLORS.indigo];
  const accentOf = (i) => _hex(accents[i % accents.length]);

  const parent = new THREE.Group();
  parent.name = 'novaGlyphs';

  // 8-point NOVA burst as a flat THREE.Shape (16 verts; outer R / inner waist).
  const OUTER = 1.0, INNER = 0.42, POINTS = 8;
  const star = new THREE.Shape();
  for (let i = 0; i < POINTS * 2; i++) {
    const rad = (i % 2 === 0) ? OUTER : INNER;
    const ang = (i / (POINTS * 2)) * Math.PI * 2 - Math.PI / 2; // first point up
    const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
    if (i === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  star.closePath();
  const starGeo = new THREE.ShapeGeometry(star);

  // Shared soft halo sprite (white -> tinted per glyph via material.color).
  const haloTex = makeRadialTexture(0xffffff, { size: 256, inner: 1.0, falloff: 2.4 });
  const haloGeo = new THREE.PlaneGeometry(1, 1);

  // High/far placements: [x, y, z, scale, opacity]; y14..30, r18..40, some far -z.
  const placements = [
    [-22, 16, -14, 2.4, 0.85],
    [ 26, 20, -18, 3.2, 0.70],
    [-14, 24,  20, 2.0, 0.80],
    [ 18, 15,  22, 1.8, 0.65],
    [  4, 28, -34, 4.0, 0.55],
    [-30, 22,   6, 2.8, 0.72],
    [ 12, 30, -28, 3.4, 0.60],
    [ -8, 18, -38, 3.0, 0.50],
    [ 34, 26,  10, 2.2, 0.68],
  ];
  const count = 7 + Math.floor(Math.random() * 2); // 7..8

  for (let i = 0; i < count; i++) {
    const [px, py, pz, s, op] = placements[i % placements.length];
    const tint = accentOf(i);

    const glyph = new THREE.Group(); // the wrapper the external loop animates
    glyph.position.set(
      px + (Math.random() - 0.5) * 4,
      py + (Math.random() - 0.5) * 3,
      pz + (Math.random() - 0.5) * 4
    );
    glyph.scale.setScalar(s);
    glyph.rotation.z = Math.random() * Math.PI * 2;

    // soft outer halo (additive bloom behind the star)
    const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({
      map: haloTex, color: _mix(tint, 0xffffff, 0.15),
      transparent: true, opacity: op * 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
    }));
    halo.scale.setScalar(4.2); halo.position.z = -0.02; halo.renderOrder = -4;
    glyph.add(halo);

    // core burst star (tinted, far ones fade into fog)
    const core = new THREE.Mesh(starGeo, new THREE.MeshBasicMaterial({
      color: _mix(tint, 0xffffff, 0.35),
      transparent: true, opacity: op, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: true, toneMapped: false, side: THREE.DoubleSide,
    }));
    core.renderOrder = -3;
    glyph.add(core);

    // inner over-star, offset 22.5deg -> 16-point sparkle nucleus
    const nucleus = new THREE.Mesh(starGeo, new THREE.MeshBasicMaterial({
      color: _mix(tint, 0xffffff, 0.6),
      transparent: true, opacity: op * 0.7, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: true, toneMapped: false, side: THREE.DoubleSide,
    }));
    nucleus.scale.setScalar(0.5); nucleus.rotation.z = Math.PI / 8;
    nucleus.position.z = 0.01; nucleus.renderOrder = -2;
    glyph.add(nucleus);

    glyph.userData.baseY = glyph.position.y;
    glyph.userData.phase = Math.random() * Math.PI * 2;
    glyph.userData.spin = (0.06 + Math.random() * 0.10) * (Math.random() < 0.5 ? -1 : 1);

    parent.add(glyph);
    scene.userData.bgGlyphs.push(glyph);
  }

  parent.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  scene.add(parent);
  return parent;
}

// ===========================================================================
//  NOVA AVATAR  —  premium rig + cosmetics.
//  External loop sets rotation.x on the 4 pivots + bobs group.position.y.
//  Build-only (no per-frame allocation); geometry/material caches reused.
// ===========================================================================
const NV_CYAN = 0x38e1ff;
const NV_VIOLET = 0x7c5cff;
const NV_DARK = 0x0b0e17;

// keyed geometry cache (never rebuild identical primitives)
const _nvGeoCache = new Map();
function nvGeo(key, build) {
  let g = _nvGeoCache.get(key);
  if (!g) { g = build(); _nvGeoCache.set(key, g); }
  return g;
}

// per-base-color material set cache
const _nvMatCache = new Map();
function nvMatSet(c) {
  let s = _nvMatCache.get(c);
  if (s) return s;

  const body = new THREE.MeshStandardMaterial({ color: c, roughness: 0.38, metalness: 0.22, emissive: c, emissiveIntensity: 0.22 });
  const trim = new THREE.MeshStandardMaterial({ color: NV_DARK, roughness: 0.55, metalness: 0.4, emissive: NV_VIOLET, emissiveIntensity: 0.06 });
  const hand = new THREE.MeshStandardMaterial({ color: c, roughness: 0.28, metalness: 0.3, emissive: c, emissiveIntensity: 0.3 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x05111a, roughness: 0.12, metalness: 0.6, emissive: NV_CYAN, emissiveIntensity: 0.85, transparent: true, opacity: 0.92 });
  const glowCyan = new THREE.MeshStandardMaterial({ color: NV_CYAN, roughness: 0.2, metalness: 0.1, emissive: NV_CYAN, emissiveIntensity: 1.4 });
  const glowViolet = new THREE.MeshStandardMaterial({ color: NV_VIOLET, roughness: 0.25, metalness: 0.1, emissive: NV_VIOLET, emissiveIntensity: 1.15 });
  const rim = new THREE.MeshBasicMaterial({ color: NV_VIOLET, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
  const metalGold = new THREE.MeshStandardMaterial({ color: 0xffd27a, roughness: 0.25, metalness: 0.9, emissive: 0xffb347, emissiveIntensity: 0.25 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x161a26, roughness: 0.85, metalness: 0.05, emissive: NV_VIOLET, emissiveIntensity: 0.08 });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x05070c, roughness: 0.15, metalness: 0.5, emissive: NV_CYAN, emissiveIntensity: 0.18, transparent: true, opacity: 0.85 });

  s = { body, trim, hand, visor, glowCyan, glowViolet, rim, metalGold, fabric, darkGlass };
  _nvMatCache.set(c, s);
  return s;
}

function nvMesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// Skin-toned material (head + neck + hands). Matte, non-metallic, barely
// emissive so it reads as skin (not a glowing orb). Built LOCAL per avatar so
// the shared nvMatSet color cache is never mutated.
function nvSkinMat(hex) {
  return new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.5, metalness: 0.1,
    emissive: hex, emissiveIntensity: 0.08,
  });
}

// HAIR — low-poly swept cap covering crown/back/sides, leaving the FACE (+z)
// open for the visor. Child of the GROUP (never the pivots) so it stays put
// while limbs swing. Matte, never glows. opts.hair (#hex) drives the color.
function addHair(group, hairHex) {
  const HEAD_Y = 1.6;
  const hairMat = new THREE.MeshStandardMaterial({
    color: hairHex, roughness: 0.65, metalness: 0.05,
    emissive: hairHex, emissiveIntensity: 0.1,
  });

  // wrap so we can match the head's non-uniform scale (1.0, 1.04, 0.98)
  const hair = new THREE.Group();
  hair.position.set(0, HEAD_Y, 0);
  hair.scale.set(1.0, 1.04, 0.98);

  // MAIN CAP — SphereGeometry(r, wSeg, hSeg, phiStart, phiLen, thetaStart, thetaLen).
  // Face points +z = azimuth 90deg; leave an 80deg gap centered there:
  // covered arc = 130deg -> 410deg (280deg). theta 0..105deg = crown down to
  // just below the equator (back + sides). Radius 0.315 > head 0.30 -> no z-fight.
  const cap = nvMesh(
    nvGeo('hair_cap', () => new THREE.SphereGeometry(
      0.315, 20, 14,
      Math.PI * 0.722,   // phiStart   = 130deg
      Math.PI * 1.556,   // phiLength  = 280deg
      0,                 // thetaStart = crown
      Math.PI * 0.583    // thetaLength = 105deg
    )),
    hairMat, 0, 0, 0
  );
  hair.add(cap);

  // FRINGE — thin front hairline band, 120deg arc centered on +z, high on the
  // forehead (theta 18..42deg) so it sits ABOVE the visor/brow, never covering them.
  const fringe = nvMesh(
    nvGeo('hair_fringe', () => new THREE.SphereGeometry(
      0.322, 18, 6,
      Math.PI * 0.167,   // phiStart  = 30deg
      Math.PI * 0.667,   // phiLength = 120deg  (centered on +z face)
      Math.PI * 0.10,    // thetaStart ~18deg
      Math.PI * 0.133    // thetaLength ~24deg
    )),
    hairMat, 0, 0, 0
  );
  hair.add(fringe);

  // SIDE TUFTS — small flattened spheres at the temples for low-poly character.
  const tuftG = nvGeo('hair_tuft', () => new THREE.SphereGeometry(0.09, 10, 8));
  const tL = nvMesh(tuftG, hairMat, -0.255, 0.06, -0.02); tL.scale.set(0.7, 1.0, 1.1);
  const tR = nvMesh(tuftG, hairMat,  0.255, 0.06, -0.02); tR.scale.set(0.7, 1.0, 1.1);
  hair.add(tL); hair.add(tR);

  group.add(hair);
}

// COSMETIC ATTACH TABLE — single source of truth for where each of the 16 ids
// is anchored on the body. Every cosmetic is a child of the GROUP (never the
// animated arm/leg pivots), so it stays put while limbs swing. The per-case
// builders below place their meshes against these anchors so nothing floats.
//   head_top : sits ON the head (~y1.9, follows head crown)
//   face     : over the visor/eyes (~y1.6, front +z ~0.235)
//   neck     : ring around the neck (~y1.34)
//   back     : behind the torso (-z ~ -0.3)  <- WINGS + BACKPACK live here
//   halo     : floats just above the head (~y2.05)
//   ears     : cups over the head sides (~x +/-0.31)
const NV_SLOT_ANCHOR = {
  head_top: [0, 1.90, 0],
  face:     [0, 1.60, 0.235],
  neck:     [0, 1.34, 0],
  back:     [0, 1.06, -0.32],
  halo:     [0, 2.05, 0],
  ears:     [0, 1.60, 0],
};
const NV_ATTACH = {
  nv_tophat:    'head_top', nv_crown:   'head_top', nv_beanie:   'head_top',
  nv_wizard:    'head_top', nv_cap:     'head_top', nv_snapback: 'head_top',
  nv_antenna:   'head_top',
  nv_glasses:   'face',     nv_shades:  'face',     nv_visor:    'face',
  nv_scarf:     'neck',     nv_chain:   'neck',
  nv_backpack:  'back',     nv_wings:   'back',
  nv_halo:      'halo',
  nv_headphones:'ears',
};

// COSMETICS — every piece is a child of the GROUP (never the pivots), so it
// stays put while limbs swing. Unknown ids are ignored.
function addCosmetic(group, id, c) {
  const M = nvMatSet(c);
  const HEAD_Y = 1.6, HEAD_R = 0.3;
  const TOP_Y = HEAD_Y + HEAD_R;   // crown of head (~1.9)
  const FACE_Z = 0.235;            // front-of-face z
  const NECK_Y = 1.34;

  switch (id) {
    // ---------------- HEADWEAR ----------------
    case 'nv_tophat': {
      const hat = new THREE.Group();
      hat.add(nvMesh(nvGeo('th_brim', () => new THREE.CylinderGeometry(0.34, 0.34, 0.03, 28)), M.fabric, 0, TOP_Y - 0.01, 0));
      hat.add(nvMesh(nvGeo('th_body', () => new THREE.CylinderGeometry(0.21, 0.23, 0.42, 28)), M.fabric, 0, TOP_Y + 0.22, 0));
      hat.add(nvMesh(nvGeo('th_band', () => new THREE.CylinderGeometry(0.235, 0.235, 0.05, 28)), M.glowCyan, 0, TOP_Y + 0.04, 0));
      group.add(hat); break;
    }
    case 'nv_crown': {
      // Royal gold crown sitting above the helmet, with FLOATING crystal shards.
      const cr = new THREE.Group();
      const baseY = TOP_Y + 0.07;
      cr.add(nvMesh(nvGeo('cr2_band', () => new THREE.CylinderGeometry(0.235, 0.25, 0.085, 28)), M.metalGold, 0, baseY, 0));
      cr.add(nvMesh(nvGeo('cr2_rim', () => new THREE.TorusGeometry(0.246, 0.018, 10, 28)), M.metalGold, 0, baseY - 0.035, 0));
      const spikeG = nvGeo('cr2_spike', () => new THREE.ConeGeometry(0.055, 0.18, 4));
      const tallG = nvGeo('cr2_tall', () => new THREE.ConeGeometry(0.06, 0.27, 4));
      const shardG = nvGeo('cr2_shard', () => new THREE.OctahedronGeometry(0.042, 0));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;   // a front point centered
        const x = Math.cos(a) * 0.235, z = Math.sin(a) * 0.235;
        const front = (i === 0);
        cr.add(nvMesh(front ? tallG : spikeG, M.metalGold, x, baseY + (front ? 0.15 : 0.1), z));
        const shard = nvMesh(shardG, i % 2 ? M.glowViolet : M.glowCyan, x, baseY + (front ? 0.36 : 0.27), z);
        shard.scale.set(1, 1.5, 1);                       // floating crystal above each point
        cr.add(shard);
      }
      const big = nvMesh(nvGeo('cr2_big', () => new THREE.OctahedronGeometry(0.06, 0)), M.glowCyan, 0, baseY + 0.05, 0.235);
      big.scale.set(1, 1.6, 1);
      cr.add(big);
      group.add(cr); break;
    }
    case 'nv_beanie': {
      const b = new THREE.Group();
      b.add(nvMesh(nvGeo('be_cap', () => new THREE.SphereGeometry(0.32, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.6)), M.fabric, 0, HEAD_Y + 0.06, 0));
      const fold = nvMesh(nvGeo('be_fold', () => new THREE.TorusGeometry(0.3, 0.04, 10, 28)), M.fabric, 0, HEAD_Y + 0.16, 0);
      fold.rotation.x = Math.PI / 2;
      b.add(fold);
      b.add(nvMesh(nvGeo('be_pom', () => new THREE.SphereGeometry(0.06, 12, 10)), M.glowCyan, 0, TOP_Y + 0.08, 0));
      group.add(b); break;
    }
    case 'nv_wizard': {
      const w = new THREE.Group();
      w.add(nvMesh(nvGeo('wz_cone', () => new THREE.ConeGeometry(0.26, 0.62, 24)), M.fabric, 0, TOP_Y + 0.28, 0));
      w.add(nvMesh(nvGeo('wz_brim', () => new THREE.CylinderGeometry(0.32, 0.32, 0.02, 24)), M.fabric, 0, TOP_Y - 0.01, 0));
      w.add(nvMesh(nvGeo('wz_star', () => new THREE.OctahedronGeometry(0.06)), M.glowCyan, 0, TOP_Y + 0.62, 0));
      group.add(w); break;
    }
    case 'nv_cap': {
      const cap = new THREE.Group();
      cap.add(nvMesh(nvGeo('cp_dome', () => new THREE.SphereGeometry(0.31, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5)), M.body, 0, HEAD_Y + 0.04, 0));
      const brim = nvMesh(nvGeo('cp_brim', () => new THREE.CylinderGeometry(0.2, 0.2, 0.03, 20, 1, false, 0, Math.PI)), M.body, 0, HEAD_Y + 0.04, 0.24);
      brim.rotation.set(0, -Math.PI / 2, 0);
      cap.add(brim);
      cap.add(nvMesh(nvGeo('cp_btn', () => new THREE.SphereGeometry(0.035, 10, 8)), M.glowCyan, 0, HEAD_Y + 0.34, 0));
      group.add(cap); break;
    }
    case 'nv_snapback': {
      const sb = new THREE.Group();
      sb.add(nvMesh(nvGeo('sb_dome', () => new THREE.SphereGeometry(0.31, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5)), M.trim, 0, HEAD_Y + 0.04, 0));
      sb.add(nvMesh(nvGeo('sb_brim', () => new THREE.BoxGeometry(0.42, 0.03, 0.26)), M.trim, 0, HEAD_Y + 0.06, 0.3));
      sb.add(nvMesh(nvGeo('sb_strip', () => new THREE.BoxGeometry(0.42, 0.012, 0.005)), M.glowViolet, 0, HEAD_Y + 0.06, 0.43));
      group.add(sb); break;
    }
    case 'nv_visor': {
      const v = new THREE.Group();
      const band = nvMesh(nvGeo('vs_band', () => new THREE.TorusGeometry(0.3, 0.035, 10, 28, Math.PI)), M.trim, 0, HEAD_Y + 0.12, 0);
      band.rotation.set(Math.PI / 2, 0, 0);
      v.add(band);
      const brim = nvMesh(nvGeo('vs_brim', () => new THREE.CylinderGeometry(0.22, 0.22, 0.025, 20, 1, false, 0, Math.PI)), M.glowCyan, 0, HEAD_Y + 0.08, 0.2);
      brim.rotation.set(0.15, -Math.PI / 2, 0);
      v.add(brim);
      group.add(v); break;
    }

    // ---------------- EYEWEAR ----------------
    case 'nv_glasses': {
      const g = new THREE.Group();
      const ringG = nvGeo('gl_ring', () => new THREE.TorusGeometry(0.075, 0.012, 8, 18));
      const l1 = nvMesh(ringG, M.metalGold, -0.1, HEAD_Y, FACE_Z); l1.rotation.y = 0.05; g.add(l1);
      const l2 = nvMesh(ringG, M.metalGold, 0.1, HEAD_Y, FACE_Z); l2.rotation.y = -0.05; g.add(l2);
      g.add(nvMesh(nvGeo('gl_bridge', () => new THREE.BoxGeometry(0.06, 0.012, 0.012)), M.metalGold, 0, HEAD_Y, FACE_Z));
      group.add(g); break;
    }
    case 'nv_shades': {
      const g = new THREE.Group();
      const lensG = nvGeo('sh_lens', () => new THREE.BoxGeometry(0.15, 0.085, 0.02));
      g.add(nvMesh(lensG, M.darkGlass, -0.1, HEAD_Y, FACE_Z));
      g.add(nvMesh(lensG, M.darkGlass, 0.1, HEAD_Y, FACE_Z));
      g.add(nvMesh(nvGeo('sh_bridge', () => new THREE.BoxGeometry(0.07, 0.018, 0.018)), M.trim, 0, HEAD_Y + 0.01, FACE_Z));
      const templeG = nvGeo('sh_temple', () => new THREE.BoxGeometry(0.02, 0.018, 0.18));
      g.add(nvMesh(templeG, M.trim, -0.2, HEAD_Y, FACE_Z - 0.12));
      g.add(nvMesh(templeG, M.trim, 0.2, HEAD_Y, FACE_Z - 0.12));
      group.add(g); break;
    }
    case 'nv_headphones': {
      const h = new THREE.Group();
      const band = nvMesh(nvGeo('hp_band', () => new THREE.TorusGeometry(0.32, 0.028, 10, 24, Math.PI)), M.trim, 0, HEAD_Y + 0.04, 0);
      band.rotation.z = Math.PI / 2; h.add(band);
      const cupG = nvGeo('hp_cup', () => new THREE.CylinderGeometry(0.09, 0.09, 0.06, 18));
      const cL = nvMesh(cupG, M.trim, -0.31, HEAD_Y - 0.02, 0); cL.rotation.z = Math.PI / 2; h.add(cL);
      const cR = nvMesh(cupG, M.trim, 0.31, HEAD_Y - 0.02, 0); cR.rotation.z = Math.PI / 2; h.add(cR);
      const ringG = nvGeo('hp_ring', () => new THREE.TorusGeometry(0.07, 0.012, 8, 18));
      const rL = nvMesh(ringG, M.glowCyan, -0.345, HEAD_Y - 0.02, 0); rL.rotation.y = Math.PI / 2; h.add(rL);
      const rR = nvMesh(ringG, M.glowCyan, 0.345, HEAD_Y - 0.02, 0); rR.rotation.y = Math.PI / 2; h.add(rR);
      group.add(h); break;
    }

    // ---------------- BACK / TORSO ----------------
    case 'nv_backpack': {
      // Crystal-powered JETPACK: twin navy thrusters + a floating crystal core + blue glow.
      const jp = new THREE.Group();
      const bz = -0.34;
      const unitG = nvGeo('jp_unit', () => new THREE.CapsuleGeometry(0.07, 0.26, 6, 12));
      jp.add(nvMesh(unitG, M.trim, -0.13, 1.08, bz));
      jp.add(nvMesh(unitG, M.trim, 0.13, 1.08, bz));
      const capG = nvGeo('jp_cap', () => new THREE.TorusGeometry(0.07, 0.012, 8, 16));
      jp.add(nvMesh(capG, M.metalGold, -0.13, 1.22, bz));
      jp.add(nvMesh(capG, M.metalGold, 0.13, 1.22, bz));
      jp.add(nvMesh(nvGeo('jp_frame', () => new THREE.BoxGeometry(0.17, 0.3, 0.08)), M.body, 0, 1.08, bz - 0.02));
      // floating crystal energy core
      const core = nvMesh(nvGeo('jp_core', () => new THREE.OctahedronGeometry(0.07, 0)), M.glowCyan, 0, 1.33, bz - 0.02);
      core.scale.set(1, 1.4, 1); jp.add(core);
      jp.add(nvMesh(nvGeo('jp_coreRing', () => new THREE.TorusGeometry(0.1, 0.012, 8, 20)), M.metalGold, 0, 1.33, bz - 0.02));
      // blue thruster glow (cones pointing down)
      const thrG = nvGeo('jp_thr', () => new THREE.ConeGeometry(0.05, 0.13, 12));
      const tL = nvMesh(thrG, M.glowCyan, -0.13, 0.9, bz); tL.rotation.x = Math.PI; jp.add(tL);
      const tR = nvMesh(thrG, M.glowCyan, 0.13, 0.9, bz); tR.rotation.x = Math.PI; jp.add(tR);
      group.add(jp); break;
    }
    case 'nv_wings': {
      // Two angled wing-blades flat on the BACK (-z), fanning up + out from the
      // spine. (Previously these splayed sideways near the arms and floated.)
      const w = new THREE.Group();
      const featherG = nvGeo('wg_feather', () => new THREE.BoxGeometry(0.5, 0.12, 0.03));
      const buildWing = (side) => {           // side -1 left, +1 right
        const wing = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const f = nvMesh(featherG, i === 1 ? M.glowViolet : M.body, 0, 0, 0);
          f.scale.set(1 - i * 0.16, 1, 1);                 // taper top -> bottom
          f.position.set(side * (0.22 + i * 0.04), 0.18 - i * 0.16, 0); // step out + down
          f.rotation.z = side * (0.45 + i * 0.18);         // fan upward / outward
          wing.add(f);
        }
        wing.position.set(side * 0.04, 0, 0);  // both wings meet near the spine
        wing.rotation.y = side * -0.35;        // angle blades back into the -z plane
        return wing;
      };
      w.add(buildWing(-1));
      w.add(buildWing(1));
      const back = NV_SLOT_ANCHOR.back;        // [0, 1.06, -0.32]
      w.position.set(back[0], back[1] + 0.18, back[2] + 0.02); // centered behind torso
      group.add(w); break;
    }

    // ---------------- NECK ----------------
    case 'nv_scarf': {
      const s = new THREE.Group();
      const ring = nvMesh(nvGeo('sc_ring', () => new THREE.TorusGeometry(0.18, 0.06, 12, 24)), M.fabric, 0, NECK_Y, 0);
      ring.rotation.x = Math.PI / 2; ring.scale.set(1, 1, 0.7);
      s.add(ring);
      s.add(nvMesh(nvGeo('sc_tail', () => new THREE.BoxGeometry(0.1, 0.26, 0.04)), M.fabric, 0.1, NECK_Y - 0.18, 0.16));
      group.add(s); break;
    }
    case 'nv_chain': {
      const ch = new THREE.Group();
      const ring = nvMesh(nvGeo('cn_ring', () => new THREE.TorusGeometry(0.17, 0.012, 8, 28)), M.metalGold, 0, NECK_Y - 0.02, 0.02);
      ring.rotation.x = Math.PI / 2.2;
      ch.add(ring);
      ch.add(nvMesh(nvGeo('cn_pend', () => new THREE.OctahedronGeometry(0.045)), M.glowCyan, 0, NECK_Y - 0.16, 0.16));
      group.add(ch); break;
    }
    case 'nv_antenna': {
      const a = new THREE.Group();
      a.add(nvMesh(nvGeo('an_rod', () => new THREE.CylinderGeometry(0.01, 0.012, 0.26, 8)), M.trim, 0, TOP_Y + 0.13, 0));
      a.add(nvMesh(nvGeo('an_tip', () => new THREE.SphereGeometry(0.04, 12, 10)), M.glowCyan, 0, TOP_Y + 0.28, 0));
      a.add(nvMesh(nvGeo('an_base', () => new THREE.SphereGeometry(0.03, 10, 8)), M.trim, 0, TOP_Y, 0));
      group.add(a); break;
    }
    case 'nv_halo': {
      const h = nvMesh(nvGeo('ha_ring', () => new THREE.TorusGeometry(0.22, 0.022, 14, 36)), M.glowCyan, 0, 2.05, 0);
      h.rotation.x = Math.PI / 2;
      group.add(h); break;
    }

    default: /* unknown id -> ignored */ break;
  }
}

// Premium "Cosmic Monarch" astronaut-suit materials. Color-INDEPENDENT pieces are
// cached once (ivory panels, deep-navy undersuit, soft gold trim, glossy blue visor);
// the player's own color becomes the personal CRYSTAL accent (emblem/forearms/glow).
let _kingMats = null;
function kingMats() {
  if (_kingMats) return _kingMats;
  _kingMats = {
    ivory: new THREE.MeshStandardMaterial({ color: 0xeef1f7, roughness: 0.40, metalness: 0.18, emissive: 0x2b3560, emissiveIntensity: 0.05 }),
    navy:  new THREE.MeshStandardMaterial({ color: 0x172a52, roughness: 0.50, metalness: 0.38, emissive: 0x0a1330, emissiveIntensity: 0.06 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x0e1730, roughness: 0.6, metalness: 0.3, emissive: 0x0a1330, emissiveIntensity: 0.04 }),
    gold:  new THREE.MeshStandardMaterial({ color: 0xf0c66a, roughness: 0.28, metalness: 0.95, emissive: 0xc98a2a, emissiveIntensity: 0.28 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x0a2a66, roughness: 0.05, metalness: 0.88, emissive: 0x2f7bff, emissiveIntensity: 0.7, transparent: true, opacity: 0.95 }),
  };
  return _kingMats;
}

export function makeNovaAvatar(color, opts) {
  const c = (color == null) ? COLORS.violet : color;
  const M = nvMatSet(c);
  const km = kingMats();
  // Player color -> personal crystal accent (faceted gem look, glowing).
  const crystal = new THREE.MeshStandardMaterial({ color: c, roughness: 0.16, metalness: 0.25, emissive: c, emissiveIntensity: 1.25 });
  const group = new THREE.Group();

  // Optional skin tone: head + neck + hands use this; everything else stays `c`.
  // LOCAL material (not cached) so nvMatSet's color cache is never corrupted.
  // null when no skin requested -> head/neck use M.body, hands use M.hand (today's behavior).
  const skinMat = (opts && opts.skin) ? nvSkinMat(opts.skin) : null;

  // ---- BODY-TYPE PRESETS (contract-safe: uniform group scale + per-mesh girth) ----
  // scale     : uniform group.scale (overall size; keeps feet at y0, proportions intact)
  // scaleY    : OPTIONAL extra vertical stretch (1 = off; >1 distorts spheres)
  // torsoGirth: x/z multiplier on torso capsule + chest plate + hip + shoulder caps
  // limbGirth : x/z multiplier on arm/leg capsules (mesh.scale only — never cached geo)
  // capOut    : how far shoulder/hip caps shift outward with girth (0..1)
  const PRESETS = {
    classic: { scale: 1.00, scaleY: 1.0, torsoGirth: 1.00, limbGirth: 1.00, capOut: 1.0 },
    slim:    { scale: 1.00, scaleY: 1.0, torsoGirth: 0.82, limbGirth: 0.85, capOut: 1.0 },
    bulky:   { scale: 1.05, scaleY: 1.0, torsoGirth: 1.22, limbGirth: 1.25, capOut: 1.0 },
    mini:    { scale: 0.78, scaleY: 1.0, torsoGirth: 1.05, limbGirth: 1.10, capOut: 1.0 },
  };
  const P = PRESETS[(opts && opts.preset)] || PRESETS.classic;

  const HIP_Y = 0.66;   // hip pivot height (contract)
  const SHO_Y = 1.40;   // shoulder pivot height (contract)
  const HEAD_Y = 1.6;

  // ---- TORSO: premium Cosmic-Monarch suit, strong V-silhouette ----
  const tg = P.torsoGirth;
  // deep-navy undersuit core (tapered: broad chest, slim waist)
  const torso = nvMesh(nvGeo('kTorso', () => new THREE.CapsuleGeometry(0.25, 0.44, 8, 20)), km.navy, 0, 1.02, 0);
  torso.scale.set(1.02 * tg, 1.0, 0.80 * tg);
  group.add(torso);
  // gold belt cinch at the slim waist
  const waist = nvMesh(nvGeo('kWaist', () => new THREE.CylinderGeometry(0.2, 0.225, 0.13, 18)), km.gold, 0, 0.83, 0);
  waist.scale.set(0.9 * tg, 1.0, 0.76 * tg);
  group.add(waist);
  // IVORY chest plate (broad, armored)
  const chestPlate = nvMesh(nvGeo('kChestPlate', () => new THREE.SphereGeometry(0.3, 24, 18)), km.ivory, 0, 1.25, 0.02);
  chestPlate.scale.set(1.18 * tg, 0.7, 0.82 * tg);
  group.add(chestPlate);
  // gold collar + center seam
  const collar = nvMesh(nvGeo('kCollar', () => new THREE.TorusGeometry(0.17, 0.022, 8, 24)), km.gold, 0, 1.37, 0.02);
  collar.rotation.x = Math.PI / 2; collar.scale.set(1.12 * tg, 1.0, 0.82 * tg);
  group.add(collar);
  group.add(nvMesh(nvGeo('kSeam', () => new THREE.BoxGeometry(0.02, 0.32, 0.02)), km.gold, 0, 1.12, 0.235));
  // abdomen panel lines (navy plates)
  for (let i = 0; i < 2; i++) {
    const ab = nvMesh(nvGeo('kAb', () => new THREE.BoxGeometry(0.24, 0.055, 0.14)), km.panel, 0, 0.98 - i * 0.1, 0.1);
    ab.scale.set(tg, 1, tg); group.add(ab);
  }
  // PAULDRONS: armored shoulder plates pushed out -> wide-shoulder V silhouette
  const shX = 0.355 * (1 + (tg - 1) * P.capOut);
  const pauldronG = nvGeo('kPauldron', () => new THREE.SphereGeometry(0.15, 18, 14));
  const paRimG = nvGeo('kPaRim', () => new THREE.TorusGeometry(0.13, 0.015, 8, 18));
  for (const s of [-1, 1]) {
    const pa = nvMesh(pauldronG, km.ivory, s * shX, SHO_Y + 0.03, 0);
    pa.scale.set(1.15 * tg, 0.85, 1.05 * tg);
    group.add(pa);
    const pr = nvMesh(paRimG, km.gold, s * shX, SHO_Y - 0.02, 0);
    pr.rotation.x = Math.PI / 2; group.add(pr);
  }
  // slim hip
  const hipCap = nvMesh(nvGeo('kHipCap', () => new THREE.SphereGeometry(0.24, 18, 12)), km.navy, 0, 0.74, 0);
  hipCap.scale.set(0.92 * tg, 0.55, 0.76 * tg);
  group.add(hipCap);

  // ---- NECK + HEAD + HELMET ----
  group.add(nvMesh(nvGeo('kNeck', () => new THREE.CylinderGeometry(0.1, 0.13, 0.18, 16)), km.navy, 0, 1.37, 0));
  const head = nvMesh(nvGeo('head', () => new THREE.SphereGeometry(0.285, 32, 24)), skinMat || M.hand, 0, HEAD_Y, 0);
  group.add(head);
  // IVORY helmet shell (clean curved dome over back/top of head)
  const helmet = nvMesh(nvGeo('kHelmet', () => new THREE.SphereGeometry(0.335, 28, 22)), km.ivory, 0, HEAD_Y + 0.01, -0.015);
  helmet.scale.set(1.04, 1.07, 1.04);
  group.add(helmet);
  // gold helmet trim ring
  const hrim = nvMesh(nvGeo('kHelmRim', () => new THREE.TorusGeometry(0.33, 0.018, 8, 28)), km.gold, 0, HEAD_Y + 0.02, 0);
  hrim.rotation.x = Math.PI * 0.5; group.add(hrim);
  // royal crest fin on top of the helmet
  group.add(nvMesh(nvGeo('kCrest', () => new THREE.BoxGeometry(0.028, 0.11, 0.17)), km.gold, 0, HEAD_Y + 0.34, -0.02));

  // ---- VISOR: big glossy reflective BLUE face shield (+~30%) + gold frame ----
  const visor = nvMesh(
    nvGeo('kVisor', () => new THREE.SphereGeometry(0.34, 30, 20, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.30, Math.PI * 0.44)),
    km.visor, 0, HEAD_Y + 0.015, 0.0
  );
  visor.scale.set(1.06, 1.0, 1.08);
  group.add(visor);
  const vframe = nvMesh(nvGeo('kVFrame', () => new THREE.TorusGeometry(0.245, 0.014, 8, 26)), km.gold, 0, HEAD_Y + 0.04, 0.14);
  vframe.rotation.set(Math.PI * 0.58, 0, 0); group.add(vframe);

  // ---- FACE: two cyan eye dots glowing through the visor + a soft smile ----
  const eyeG = nvGeo('eye', () => new THREE.SphereGeometry(0.028, 10, 8));
  const eyeL = nvMesh(eyeG, M.glowCyan, -0.085, HEAD_Y + 0.01, 0.27); eyeL.scale.set(1.0, 1.3, 0.6);
  const eyeR = nvMesh(eyeG, M.glowCyan,  0.085, HEAD_Y + 0.01, 0.27); eyeR.scale.set(1.0, 1.3, 0.6);
  group.add(eyeL); group.add(eyeR);
  const mouth = nvMesh(nvGeo('mouth', () => new THREE.TorusGeometry(0.06, 0.008, 6, 16, Math.PI)), M.trim, 0, HEAD_Y - 0.13, 0.27);
  mouth.rotation.set(Math.PI, 0, 0);   // arc curves up at the ends -> friendly smile
  group.add(mouth);

  // ---- ROYAL CRYSTAL CHEST EMBLEM (player color) in a gold setting ----
  const chest = nvMesh(nvGeo('kGem', () => new THREE.OctahedronGeometry(0.075, 0)), crystal, 0, 1.2, 0.255);
  chest.scale.set(1.0, 1.4, 1.0);   // tall diamond
  group.add(chest);
  const setting = nvMesh(nvGeo('kGemSet', () => new THREE.OctahedronGeometry(0.11, 0)), km.gold, 0, 1.2, 0.235);
  setting.scale.set(1.0, 1.5, 0.5);
  group.add(setting);
  group.add(nvMesh(nvGeo('kGemRing', () => new THREE.TorusGeometry(0.085, 0.01, 8, 20)), km.gold, 0, 1.2, 0.25));

  // ---- LEG PIVOTS (hips). Legs hang below; feet are children. ----
  const legGeo = nvGeo('leg', () => new THREE.CapsuleGeometry(0.125, 0.42, 6, 14));
  const kneeGeo = nvGeo('knee', () => new THREE.SphereGeometry(0.115, 12, 10));
  const footGeo = nvGeo('foot', () => new THREE.BoxGeometry(0.19, 0.1, 0.32));
  const toeGeo = nvGeo('toe', () => new THREE.SphereGeometry(0.095, 12, 10));
  const soleGeo = nvGeo('sole', () => new THREE.BoxGeometry(0.18, 0.02, 0.3));

  function makeLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.14, HIP_Y, 0);
    const lg = P.limbGirth * 0.92;   // slimmer, athletic
    // navy thigh
    const legMesh = nvMesh(legGeo, km.navy, 0, -0.32, 0);
    legMesh.scale.set(lg, 1.0, lg);
    pivot.add(legMesh);
    // ivory shin guard (lower leg)
    const shin = nvMesh(nvGeo('kShin', () => new THREE.CapsuleGeometry(0.1, 0.2, 6, 12)), km.ivory, 0, -0.43, 0.03);
    shin.scale.set(lg, 1.0, lg * 0.92);
    pivot.add(shin);
    // knee armor plate + gold rim
    const kneeMesh = nvMesh(kneeGeo, km.ivory, 0, -0.3, 0.04);
    kneeMesh.scale.setScalar(lg * 1.04);
    pivot.add(kneeMesh);
    pivot.add(nvMesh(nvGeo('kKneeRim', () => new THREE.TorusGeometry(0.1, 0.012, 8, 16)), km.gold, 0, -0.3, 0.05));
    // crystal accent on outer thigh
    pivot.add(nvMesh(nvGeo('kThighGem', () => new THREE.OctahedronGeometry(0.028, 0)), crystal, side * 0.1, -0.2, 0.05));
    // sleeker, slightly smaller boot (ivory + navy heel + gold trim + crystal sole)
    const foot = nvMesh(footGeo, km.ivory, 0, -0.62, 0.04);
    foot.scale.set(0.92, 0.95, 0.92);
    pivot.add(foot);
    const heel = nvMesh(nvGeo('heel', () => new THREE.BoxGeometry(0.16, 0.11, 0.1)), km.navy, 0, -0.61, -0.08);
    pivot.add(heel);
    const toe = nvMesh(toeGeo, km.ivory, 0, -0.6, 0.16); toe.scale.set(0.95, 0.8, 1.1);
    pivot.add(toe);
    pivot.add(nvMesh(nvGeo('kBootTrim', () => new THREE.BoxGeometry(0.19, 0.03, 0.32)), km.gold, 0, -0.57, 0.04));
    pivot.add(nvMesh(soleGeo, crystal, 0, -0.665, 0.04));
    group.add(pivot);
    return { pivot, foot };
  }
  const L = makeLeg(-1), R = makeLeg(1);

  // ---- ARM PIVOTS (shoulders). Arms + hands hang below. ----
  const armGeo = nvGeo('arm', () => new THREE.CapsuleGeometry(0.085, 0.42, 6, 12));
  const handGeo = nvGeo('hand', () => new THREE.SphereGeometry(0.085, 14, 12));
  const cuffGeo = nvGeo('cuff', () => new THREE.TorusGeometry(0.085, 0.018, 8, 16));

  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.35, SHO_Y, 0);            // a touch wider -> stronger V
    pivot.rotation.z = side === -1 ? 0.16 : -0.16;        // resting splay (contract)
    const lg = P.limbGirth;
    // navy upper arm
    const armMesh = nvMesh(armGeo, km.navy, 0, -0.24, 0);
    armMesh.scale.set(lg * 0.95, 0.95, lg * 0.95);
    pivot.add(armMesh);
    // IVORY armored forearm bracer
    const bracer = nvMesh(nvGeo('kBracer', () => new THREE.CapsuleGeometry(0.082, 0.2, 6, 12)), km.ivory, 0, -0.4, 0);
    bracer.scale.set(lg * 1.05, 1.0, lg * 1.05);
    pivot.add(bracer);
    // crystal accent on the forearm
    pivot.add(nvMesh(nvGeo('kArmGem', () => new THREE.OctahedronGeometry(0.03, 0)), crystal, side * 0.02, -0.38, 0.07));
    // gold wrist cuff
    const cuff = nvMesh(cuffGeo, km.gold, 0, -0.49, 0);
    cuff.rotation.x = Math.PI / 2;
    pivot.add(cuff);
    // slightly LARGER hand (skin) + thumb nub
    const palm = nvMesh(handGeo, skinMat || M.hand, 0, -0.55, 0);
    palm.scale.set(1.15, 1.25, 0.85);
    pivot.add(palm);
    const thumb = nvMesh(nvGeo('thumb', () => new THREE.SphereGeometry(0.034, 8, 6)), skinMat || M.hand, side * 0.07, -0.53, 0.02);
    thumb.scale.set(0.85, 1.2, 0.85);
    pivot.add(thumb);
    group.add(pivot);
    return pivot;
  }
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);

  // ---- SOFT UNDER-GLOW RIM (ground halo) ----
  const rim = nvMesh(nvGeo('rim', () => new THREE.CircleGeometry(0.5, 32)), M.rim, 0, 0.012, 0);
  rim.rotation.x = -Math.PI / 2;
  rim.castShadow = false; rim.receiveShadow = false;
  group.add(rim);

  // ---- HAIR (child of GROUP; sits on head; layered UNDER any hat) ----
  if (opts && opts.hair) addHair(group, opts.hair);

  // ---- COSMETICS (children of GROUP so they don't swing) ----
  if (opts && Array.isArray(opts.cosmetics)) {
    for (let i = 0; i < opts.cosmetics.length; i++) addCosmetic(group, opts.cosmetics[i], c);
  }

  // ---- PARTS CONTRACT (exact) ----
  group.userData.parts = {
    head, visor, torso, chest,
    leftArm, rightArm,
    leftLeg: L.pivot, rightLeg: R.pivot,
    leftFoot: L.foot, rightFoot: R.foot,
  };

  // ---- BODY-TYPE OVERALL SIZE (uniform; feet stay at y0 since origin is y0,
  //      and rotation.x on pivots + group.position.y bob are scale-independent) ----
  if (P.scale !== 1.0 || P.scaleY !== 1.0) {
    group.scale.set(P.scale, P.scale * P.scaleY, P.scale);
  }

  return group;
}

// ===========================================================================
//  GAMEPLAY VISUALS  —  collectible orb / bomb marker / holder ring.
//  Each is built centered at origin; the game loop places + animates them
//  (bob/spin/position). Lightweight, additive glows, no per-frame allocation.
// ===========================================================================

// makeOrb(accent) — faceted glowing collectible gem, centered at origin.
// IcosahedronGeometry facets + bright sparkle core + crossed additive halos.
// Animated externally (bob/spin). ~r0.35.
export function makeOrb(accent) {
  const color = _hex(accent != null ? accent : 0x38e1ff);
  const group = new THREE.Group();

  // faceted gem body
  const gem = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.35, 0),
    new THREE.MeshStandardMaterial({
      color: color, emissive: color, emissiveIntensity: 1.6,
      metalness: 0.4, roughness: 0.25, flatShading: true,
    })
  );
  gem.castShadow = false;
  group.add(gem);

  // inner hot core (mix toward white) for a sparkle nucleus
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.14, 0),
    new THREE.MeshBasicMaterial({ color: _mix(color.getHex(), 0xffffff, 0.65), toneMapped: false })
  );
  core.castShadow = false;
  group.add(core);

  // additive halo: two crossed billboard planes (reads from all angles)
  const haloMat = new THREE.MeshBasicMaterial({
    map: makeRadialTexture(accent != null ? accent : 0x38e1ff, { size: 256, inner: 1.0, falloff: 2.2 }),
    transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const haloGeo = new THREE.PlaneGeometry(1.8, 1.8);
  const halo0 = new THREE.Mesh(haloGeo, haloMat); halo0.castShadow = false; group.add(halo0);
  const halo1 = new THREE.Mesh(haloGeo, haloMat); halo1.rotation.y = Math.PI / 2; halo1.castShadow = false; group.add(halo1);

  return group;
}

// makeBombMarker() — floats above the bomb-holder's head. Dark sphere body +
// tilted fuse with a glowing spark + a faint red danger glow. ~r0.3.
export function makeBombMarker() {
  const group = new THREE.Group();

  // dark bomb sphere (barely-emissive red so it's never pure black)
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 20, 16),
    new THREE.MeshStandardMaterial({
      color: _hex(0x0b0e17), roughness: 0.6, metalness: 0.4,
      emissive: _hex(0x3a0000), emissiveIntensity: 0.6,
    })
  );
  body.castShadow = false; body.receiveShadow = false;
  group.add(body);

  // fuse cord: thin tilted cylinder seated on the sphere top (y=+0.3)
  const fuseLength = 0.22;
  const angle = Math.PI * 0.13;
  const fuse = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, fuseLength, 8),
    new THREE.MeshStandardMaterial({ color: _hex(0x1a110a), roughness: 0.95, metalness: 0.0 })
  );
  fuse.castShadow = false;
  fuse.position.set(0.07, 0.3 + fuseLength * 0.5, 0);
  fuse.rotation.z = angle;
  group.add(fuse);

  // spark at the fuse tip (compute tip from fuse center + tilt)
  const tipX = 0.07 + Math.sin(angle) * fuseLength * 0.5;
  const tipY = 0.3 + fuseLength * 0.5 + Math.cos(angle) * fuseLength * 0.5;
  const spark = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 10, 8),
    new THREE.MeshStandardMaterial({
      color: _hex(0xff8a3c), emissive: _hex(0xff8a3c), emissiveIntensity: 4.0,
      roughness: 0.3, metalness: 0.0, toneMapped: false,
    })
  );
  spark.castShadow = false;
  spark.position.set(tipX, tipY, 0);
  group.add(spark);

  // spark bloom: crossed additive halos at the tip
  const sparkHaloMat = new THREE.MeshBasicMaterial({
    map: makeRadialTexture(0xff5500, { size: 128, inner: 1.0, falloff: 1.8 }),
    transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const sparkHaloGeo = new THREE.PlaneGeometry(0.22, 0.22);
  const sh0 = new THREE.Mesh(sparkHaloGeo, sparkHaloMat); sh0.castShadow = false; sh0.position.set(tipX, tipY, 0); group.add(sh0);
  const sh1 = new THREE.Mesh(sparkHaloGeo, sparkHaloMat); sh1.castShadow = false; sh1.position.set(tipX, tipY, 0); sh1.rotation.y = Math.PI / 2; group.add(sh1);

  // faint red danger glow around the whole bomb: crossed additive planes
  const glowMat = new THREE.MeshBasicMaterial({
    map: makeRadialTexture(0xff3b3b, { size: 256, inner: 0.85, falloff: 2.2 }),
    transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const glowGeo = new THREE.PlaneGeometry(1.4, 1.4);
  const g0 = new THREE.Mesh(glowGeo, glowMat); g0.castShadow = false; group.add(g0);
  const g1 = new THREE.Mesh(glowGeo, glowMat); g1.castShadow = false; g1.rotation.y = Math.PI / 2; group.add(g1);

  return group;
}

// makeHolderRing(color) — flat glowing danger ring lying in the XZ plane, to
// sit on the ground under the bomb holder. ~r0.7. color default #ff5c7a.
export function makeHolderRing(color) {
  const c = (color == null) ? 0xff5c7a : color;
  const col = _hex(c);
  const group = new THREE.Group();

  // main glowing torus rim (flat)
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(0.7, 0.05, 8, 48),
    new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 1.6,
      toneMapped: false, transparent: true, opacity: 1.0,
    })
  );
  torus.rotation.x = Math.PI / 2;
  torus.castShadow = false; torus.receiveShadow = false;
  group.add(torus);

  // thinner concentric outer torus (additive accent)
  const outerTorus = new THREE.Mesh(
    new THREE.TorusGeometry(0.82, 0.018, 8, 48),
    new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
  );
  outerTorus.rotation.x = Math.PI / 2;
  outerTorus.castShadow = false;
  group.add(outerTorus);

  // additive flat ring band just inside the main rim
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.58, 0.72, 64),
    new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.18,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.castShadow = false;
  group.add(ring);

  // soft radial glow pool on the ground (danger light spill)
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({
      map: makeRadialTexture(c, { size: 256, inner: 1.0, falloff: 2.2 }),
      color: col, transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.001;
  glow.castShadow = false;
  group.add(glow);

  // small radial tick marks for premium detail
  const tickGeo = new THREE.PlaneGeometry(0.03, 0.1);
  const tickMat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  const tickCount = 8;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2;
    const tick = new THREE.Mesh(tickGeo, tickMat);
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = a;
    tick.position.set(Math.cos(a) * 0.7, 0.001, Math.sin(a) * 0.7);
    tick.castShadow = false;
    group.add(tick);
  }

  return group;
}

// ===========================================================================
//  CHARACTER ANIMATION  —  applyAvatarPose(group, { state, speed, t, dt })
//  Roblox-style procedural locomotion. Poses the makeNovaAvatar rig each
//  frame: idle / walk / run / jump / fall, smoothly cross-blended.
//
//  Replaces the game loop's simple walk/idle posing — the integrator calls
//  this once per frame instead, AFTER setting group.position for the frame
//  (so the vertical bob is applied as a safe additive on group.position.y).
//
//  Rig facts it relies on (from makeNovaAvatar):
//    parts.leftLeg / rightLeg  = HIP pivot Groups; leg hangs below -> a leg
//        swings on rotation.x. NEGATIVE rotation.x swings that foot FORWARD
//        (geometry sits at local -y; rotating +x sends -y toward -z/back).
//    parts.leftArm / rightArm  = SHOULDER pivot Groups; same axis. Resting
//        rotation.z = +0.16 (left) / -0.16 (right) is PRESERVED every frame.
//    parts.head / torso        = meshes (nod / lean about their own centres).
//
//  Continuous stride PHASE is integrated from speed and persisted on
//  group.userData so it never pops between frames or states. All applied pose
//  scalars are stored on group.userData.pose and eased toward per-state
//  targets with a framerate-independent damp  a = 1 - exp(-dt*k), so
//  walk->run->jump->fall->land transitions are smooth, never snappy.
// ===========================================================================
const _NV_POSE_TARGETS = {
  // legSwing / armSwing : stride amplitudes (rad)  |  bob : vertical (units)
  // lean : forward tilt (rad)  | hipTuck : both hips forward in air (rad)
  // armRaise : both shoulders up in air (rad)  | splay : limbs spread (rad)
  // breathe : idle breathing weight (0..1)
  idle: { legSwing: 0.04, armSwing: 0.05, bob: 0.004, lean: 0.00, hipTuck: 0.00, armRaise: 0.00, splay: 0.00, breathe: 1.0 },
  walk: { legSwing: 0.55, armSwing: 0.45, bob: 0.030, lean: 0.06, hipTuck: 0.00, armRaise: 0.00, splay: 0.00, breathe: 0.15 },
  run:  { legSwing: 0.95, armSwing: 0.85, bob: 0.060, lean: 0.18, hipTuck: 0.00, armRaise: 0.00, splay: 0.00, breathe: 0.00 },
  jump: { legSwing: 0.00, armSwing: 0.00, bob: 0.000, lean: 0.10, hipTuck: 0.85, armRaise: 2.40, splay: 0.18, breathe: 0.00 },
  fall: { legSwing: 0.00, armSwing: 0.00, bob: 0.000, lean: -0.10, hipTuck: 0.22, armRaise: 1.60, splay: 0.55, breathe: 0.00 },
};
// Per-channel blend rates (1/s). Gait amplitudes ease softly; pose offsets
// (air tuck / raise / lean / splay) snap a touch quicker so take-off + landing
// feel impulsive without popping.
const _NV_POSE_K = {
  legSwing: 8, armSwing: 9, bob: 7, lean: 12, hipTuck: 13, armRaise: 12, splay: 11, breathe: 5,
};

export function applyAvatarPose(group, opts) {
  if (!group || !group.userData || !group.userData.parts) return;
  const parts = group.userData.parts;
  const o = opts || {};
  const state = _NV_POSE_TARGETS[o.state] ? o.state : 'idle';
  const speed = (o.speed == null || isNaN(o.speed)) ? 0 : Math.max(0, o.speed);

  // ---- dt / t guards ---------------------------------------------------
  const ud = group.userData;
  let t = o.t;
  if (t == null || isNaN(t)) t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  let dt = o.dt;
  if (dt == null || isNaN(dt)) dt = (ud._poseLastT != null) ? (t - ud._poseLastT) : 1 / 60;
  if (!(dt > 0)) dt = 0;                 // pause / negative-clock -> hold
  if (dt > 0.05) dt = 0.05;             // tab-stall clamp -> no teleport
  ud._poseLastT = t;

  // ---- one-time init (start AT idle so frame 1 holds, not ramps) -------
  if (!ud.pose) {
    const i = _NV_POSE_TARGETS.idle;
    ud.pose = {
      legSwing: i.legSwing, armSwing: i.armSwing, bob: i.bob, lean: i.lean,
      hipTuck: i.hipTuck, armRaise: i.armRaise, splay: i.splay, breathe: i.breathe,
    };
    ud.stridePhase = 0;
    ud.breathPhase = Math.random() * Math.PI * 2;   // desync many avatars
    ud.strideFreq = 0.0;
    ud.poseBaseY = group.position.y;                  // bob datum (loop resets pos each frame)
    ud._poseHeadY = (parts.head && parts.head.position) ? parts.head.position.y : 1.6;
    ud._poseState = state;
  }
  const pose = ud.pose;
  const TWO_PI = Math.PI * 2;

  // ---- stride frequency from speed (one continuous phase, freq-modulated)
  // speed ~ 0..12 game units/s. Walk band 0.5..4, run band 4..8, hard cap.
  let freqTarget;
  if (state === 'jump' || state === 'fall') {
    freqTarget = 0;                                   // freeze stride in the air...
  } else if (speed <= 0.5) {
    freqTarget = 0;                                   // ...and when essentially still (no foot-slide)
  } else if (speed <= 4.0) {
    freqTarget = 1.0 + (speed - 0.5) / 3.5 * 1.2;     // 1.0 -> 2.2 Hz
  } else {
    freqTarget = 2.2 + Math.min(1.0, (speed - 4.0) / 4.0) * 1.2; // 2.2 -> 3.4 Hz
  }
  if (freqTarget > 3.8) freqTarget = 3.8;             // anti-jitter cap
  // ease the cadence (don't touch the phase) so it never snaps
  ud.strideFreq += (freqTarget - ud.strideFreq) * (1 - Math.exp(-dt * 6));

  // advance phases (integrated, wrapped, NEVER reset -> no pop on land)
  ud.stridePhase += ud.strideFreq * TWO_PI * dt;
  ud.stridePhase %= TWO_PI; if (ud.stridePhase < 0) ud.stridePhase += TWO_PI;
  ud.breathPhase += 0.25 * TWO_PI * dt;
  ud.breathPhase %= TWO_PI; if (ud.breathPhase < 0) ud.breathPhase += TWO_PI;

  // ---- blend every channel toward this state's target ------------------
  let tgt = _NV_POSE_TARGETS[state];
  // amplitude grows within walk/run with speed too, so the very start of a
  // walk isn't full-amplitude (reads as a real acceleration into the gait).
  if (state === 'walk' || state === 'run') {
    const w = Math.min(1, speed / 8);
    tgt = {
      legSwing: tgt.legSwing * (0.35 + 0.65 * w),
      armSwing: tgt.armSwing * (0.35 + 0.65 * w),
      bob: tgt.bob * (0.35 + 0.65 * w),
      lean: tgt.lean * (0.4 + 0.6 * w),
      hipTuck: tgt.hipTuck, armRaise: tgt.armRaise, splay: tgt.splay, breathe: tgt.breathe,
    };
  }
  for (const key in _NV_POSE_K) {
    const a = 1 - Math.exp(-dt * _NV_POSE_K[key]);
    pose[key] += (tgt[key] - pose[key]) * a;
  }
  ud._poseState = state;

  // ---- write the rig ---------------------------------------------------
  const ph = ud.stridePhase;
  const s = Math.sin(ph);
  const bph = ud.breathPhase;
  const br = Math.sin(bph) * pose.breathe;            // breathing wave (idle-weighted)

  // Contralateral stride: NEGATIVE rotation.x = limb forward.
  // left leg leads forward (-x) when s>0; right leg + the opposite arms mirror.
  const { leftLeg, rightLeg, leftArm, rightArm, head, torso } = parts;

  // hipTuck is stored positive; NEGATIVE rotation.x tucks the knees up in FRONT.
  if (leftLeg) leftLeg.rotation.x = -pose.legSwing * s - pose.hipTuck;
  if (rightLeg) rightLeg.rotation.x = pose.legSwing * s - pose.hipTuck;
  if (leftLeg) leftLeg.rotation.z = -pose.splay * 0.55;     // legs spread outward in the air
  if (rightLeg) rightLeg.rotation.z = pose.splay * 0.55;

  // Arms swing OPPOSITE their same-side leg (left arm back when left leg fwd),
  // minus the overhead raise, while keeping the resting +/-0.16 z splay (+ air splay).
  if (leftArm) {
    leftArm.rotation.x = pose.armSwing * s - pose.armRaise;
    leftArm.rotation.z = 0.16 + pose.splay;
  }
  if (rightArm) {
    rightArm.rotation.x = -pose.armSwing * s - pose.armRaise;
    rightArm.rotation.z = -0.16 - pose.splay;
  }

  // Torso lean (about its own centre) + a tiny breathing rise of the chest.
  if (torso) torso.rotation.x = pose.lean - br * 0.04;

  // Head: gentle nod with the gait, a soft idle nod, and a slight look-down in air.
  if (head) {
    const airLook = (pose.hipTuck + pose.armRaise) * 0.04;   // dips the head when tucked/reaching
    head.rotation.x = Math.cos(ph) * pose.legSwing * 0.06 + br * 0.05 - airLook;
    head.rotation.z = s * pose.legSwing * 0.05 + br * 0.03;
    head.position.y = ud._poseHeadY + br * 0.006;             // absolute (loop doesn't reset head)
  }

  // Whole-figure forward lean into travel (body mass is ABOVE the feet pivot,
  // so +rotation.x tips the top forward) — kept subtle.
  group.rotation.x = pose.lean * 0.5;

  // Vertical bob: 2 dips per stride (foot-plants), plus the idle breath swell.
  // ADDITIVE — the game loop sets group.position fresh before this runs.
  const sc = group.scale ? group.scale.y : 1;
  const bob = -pose.bob * (1 - Math.cos(ph * 2)) * 0.5;       // dips on each plant, never rises
  group.position.y += (bob + br * 0.012) * sc;
}
