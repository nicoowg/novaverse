// hub.js - NovaVerse in-app spil-browser (Roblox-koncept: ud af spillet -> find andre spil).
// Henter spil-kataloget fra authd (/v1/games) med et indbygget offline-fallback,
// saa hub'en ALTID viser noget. Identitet (navn/farve/token) baeres i URL'en og
// genfindes fra sessionStorage. Klik paa et kort -> index.html?game=...&name=...&color=...&token=...

(function () {
  'use strict';

  // --- Identitet: URL er primaer, sessionStorage er backup, ellers gaeste-default ---
  var qs = new URLSearchParams(location.search);
  function pick(key, ss, def) {
    var v = qs.get(key);
    if (v) { try { sessionStorage.setItem(ss, v); } catch (e) {} return v; }
    try { var s = sessionStorage.getItem(ss); if (s) return s; } catch (e) {}
    return def;
  }
  var NAME  = pick('name',  'nv_name',  'Spiller');
  var COLOR = normHex(pick('color', 'nv_color', '#7C5CFF')) || '#7C5CFF';
  var TOKEN = pick('token', 'nv_token', '');
  // Fuld avatar baeres med, saa look bevares hub -> spil (matcher hjemmesiden).
  var SKIN  = pick('skin',  'nv_skin',  '');
  var HAIR  = pick('hair',  'nv_hair',  '');
  var PRESET = pick('preset', 'nv_preset', '');
  var AVITEMS = pick('items', 'nv_items', '');

  function normHex(c) {
    if (!c) return null;
    var s = String(c).trim(); if (s[0] !== '#') s = '#' + s;
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
  }

  // Spiller-chip
  document.getElementById('p-name').textContent = NAME;
  var pdot = document.getElementById('p-dot');
  pdot.style.background = COLOR;
  pdot.style.boxShadow = '0 0 10px 1px ' + rgba(COLOR, .5);

  // --- Fallback-katalog (matcher authd handleGames; bruges hvis serveren er nede) ---
  var FALLBACK = [
    { id:'nova-hub',    title:'Nova Hub',    description:'Moedested for alle - haeng ud og mød andre.', accent:'#8b5cff', mode:'social' },
    { id:'time-bomb',   title:'Time Bomb',   description:'Send bomben videre - vaer ikke den der eksploderer.', accent:'#ff5c7a', mode:'bomb' },
    { id:'sky-parkour', title:'Sky Parkour', description:'Hop fra plade til plade og naa toppen.', accent:'#38e1ff', mode:'parkour' },
    { id:'tag-arena',   title:'Tag Arena',   description:'Undvig fangeren paa den aabne bane.', accent:'#ffc24b', mode:'tag' },
    { id:'nova-drift',  title:'Nova Drift',  description:'Hurtigste rundt om banen vinder.', accent:'#4d7cff', mode:'race' },
  ];

  var MODE_LABEL = { social:'Moedested', bomb:'Bombe', parkour:'Parkour', tag:'Fangeleg', race:'Raes', explore:'Udforsk' };
  // Egne motiver pr. spil-id (sociale spil deler ellers samme motiv).
  var KIND_BY_ID = { 'crystal-caves':'caverns', 'neon-city':'city', 'sky-garden':'garden' };
  function kindFor(g) { return KIND_BY_ID[g.id] || g.mode; }

  // --- Hent katalog fra serveren med timeout, fald tilbage ved fejl ---
  fetchGames().then(function (res) {
    render(res.games);
    setConn(res.live);
  });

  function fetchGames() {
    var cfgApi = (window.NOVA_CONFIG && window.NOVA_CONFIG.api) ? window.NOVA_CONFIG.api : '';
    var hosts = cfgApi ? [cfgApi + '/v1/games'] : ['http://127.0.0.1:8081/v1/games', 'http://localhost:8081/v1/games'];
    var i = 0;
    function tryNext() {
      if (i >= hosts.length) return Promise.resolve({ games: FALLBACK, live: false });
      var url = hosts[i++];
      return withTimeout(fetch(url, { mode: 'cors' }), 1800)
        .then(function (r) { return r && r.ok ? r.json() : Promise.reject(); })
        .then(function (data) {
          var arr = Array.isArray(data) ? data : (data && data.games);
          if (Array.isArray(arr) && arr.length) return { games: arr, live: true };
          return Promise.reject();
        })
        .catch(tryNext);
    }
    return tryNext();
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var to = setTimeout(function () { if (!done) { done = true; reject(); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(to); resolve(v); } },
             function (e) { if (!done) { done = true; clearTimeout(to); reject(e); } });
    });
  }

  // --- Render ---
  function render(games) {
    games = games.map(function (g) {
      return {
        id: g.id, title: g.title || g.id,
        description: g.description || '',
        accent: normHex(g.accent) || '#8b5cff',
        mode: g.mode || 'social',
      };
    });

    // Featured = Time Bomb hvis den findes, ellers foerste ikke-sociale, ellers foerste.
    var hero = games.filter(function (g) { return g.id === 'time-bomb'; })[0]
            || games.filter(function (g) { return g.mode !== 'social'; })[0]
            || games[0];

    var heroEl = document.getElementById('hero');
    heroEl.style.setProperty('--c-accent', hero.accent);
    heroEl.innerHTML =
      '<div class="art">' + motif(kindFor(hero), hero.accent, true) + '</div>' +
      '<div class="scrim"></div>' +
      '<span class="feat">Fremhaevet spil</span>' +
      '<h2>' + esc(hero.title) + '</h2>' +
      '<p>' + esc(hero.description) + '</p>' +
      '<span class="play">' + iconPlay() + ' Spil nu</span>';
    heroEl.onclick = function () { joinGame(hero.id); };

    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    games.forEach(function (g, idx) {
      var card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--c-accent', g.accent);
      card.style.setProperty('--i', idx);
      card.innerHTML =
        '<div class="thumb">' + motif(kindFor(g), g.accent, false) + '</div>' +
        '<div class="body">' +
          '<p class="title">' + esc(g.title) + '</p>' +
          '<p class="desc">' + esc(g.description) + '</p>' +
          '<div class="row">' +
            '<span class="mode"><span class="d"></span>' + (MODE_LABEL[g.mode] || g.mode) + '</span>' +
            '<span class="join">' + iconPlay() + ' Join</span>' +
          '</div>' +
        '</div>';
      card.onclick = function () { joinGame(g.id); };
      grid.appendChild(card);
    });

    document.getElementById('game-count').textContent = games.length + ' spil';
  }

  function joinGame(id) {
    var q = new URLSearchParams();
    q.set('game', id);
    q.set('name', NAME);
    q.set('color', COLOR);
    if (TOKEN) q.set('token', TOKEN);
    if (SKIN) q.set('skin', SKIN);
    if (HAIR) q.set('hair', HAIR);
    if (PRESET) q.set('preset', PRESET);
    if (AVITEMS) q.set('items', AVITEMS);
    location.href = 'index.html?' + q.toString();
  }

  function setConn(live) {
    var el = document.getElementById('conn');
    var lbl = document.getElementById('conn-label');
    if (live) { el.classList.add('live'); lbl.textContent = 'forbundet til NovaVerse'; }
    else { el.classList.remove('live'); lbl.textContent = 'offline-katalog'; }
  }

  // --- Map-motiv pr. spiltype (lille handtegnet SVG-preview over moerk gradient) ---
  function motif(mode, accent, big) {
    var bg =
      '<defs>' +
        '<linearGradient id="g_' + uid + '" x1="0" y1="0" x2="320" y2="200" gradientUnits="userSpaceOnUse">' +
          '<stop stop-color="' + shade(accent, .22) + '"/><stop offset="1" stop-color="#0a0b12"/>' +
        '</linearGradient>' +
        '<radialGradient id="r_' + uid + '" cx="50%" cy="42%" r="60%">' +
          '<stop stop-color="' + rgba(accent, .42) + '"/><stop offset="1" stop-color="rgba(0,0,0,0)"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<rect width="320" height="200" fill="url(#g_' + uid + ')"/>' +
      '<rect width="320" height="200" fill="url(#r_' + uid + ')"/>';
    var body = shapesFor(mode, accent);
    var svg = '<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + bg + body + '</svg>';
    uid++;
    return svg;
  }
  var uid = 0;

  function shapesFor(mode, a) {
    var st = 'stroke="' + a + '" stroke-width="3" fill="none" stroke-linejoin="round" stroke-linecap="round"';
    var gl = 'fill="' + a + '"';
    switch (mode) {
      case 'bomb': // arena: ringmur + central glodende kerne (bomben)
        var walls = '';
        for (var i = 0; i < 18; i++) {
          var an = (i / 18) * Math.PI * 2;
          var x = 160 + Math.cos(an) * 92, y = 108 + Math.sin(an) * 58;
          walls += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.4" ' + gl + ' opacity="0.8"/>';
        }
        return walls +
          '<ellipse cx="160" cy="108" rx="34" ry="22" ' + st + ' opacity="0.5"/>' +
          '<circle cx="160" cy="108" r="13" ' + gl + '/>' +
          '<circle cx="160" cy="108" r="22" stroke="' + a + '" stroke-width="2" fill="none" opacity="0.6"/>' +
          '<path d="M160 95 q9 -12 17 -6" ' + st + ' opacity="0.9"/>';
      case 'parkour': // svaevende trappe-plader
        var plats = [[40,150,70],[120,124,64],[196,96,60],[252,70,56]];
        var p = '';
        plats.forEach(function (q) {
          p += '<rect x="' + q[0] + '" y="' + q[1] + '" width="' + q[2] + '" height="13" rx="5" ' + gl + ' opacity="0.85"/>';
          p += '<rect x="' + q[0] + '" y="' + (q[1]+13) + '" width="' + q[2] + '" height="7" rx="3" fill="' + shade(a,.5) + '" opacity="0.5"/>';
        });
        return p;
      case 'tag': // aaben bane med spredte daekningsblokke
        var blocks = [[60,120,34],[150,150,28],[210,104,40],[110,80,24],[256,140,30]];
        var b = '';
        blocks.forEach(function (q) {
          b += '<rect x="' + q[0] + '" y="' + q[1] + '" width="' + q[2] + '" height="' + q[2] + '" rx="7" ' + gl + ' opacity="0.78"/>';
        });
        return b;
      case 'race': // to skinner + start-gate
        return '<path d="M96 188 L138 40" ' + st + '/>' +
               '<path d="M224 188 L182 40" ' + st + '/>' +
               '<line x1="120" y1="120" x2="200" y2="120" stroke="' + a + '" stroke-width="2" opacity="0.45"/>' +
               '<line x1="108" y1="160" x2="212" y2="160" stroke="' + a + '" stroke-width="2" opacity="0.35"/>' +
               '<ellipse cx="160" cy="52" rx="34" ry="13" ' + st + ' opacity="0.9"/>';
      case 'caverns': { // Crystal Caves: lysende krystal-spidser
        var sp = '<ellipse cx="160" cy="168" rx="124" ry="14" fill="' + a + '" opacity="0.12"/>';
        var spikes = [[58,160,46],[112,168,72],[170,150,58],[226,166,50],[150,176,30]];
        spikes.forEach(function (q) {
          var x = q[0], by = q[1], h = q[2];
          sp += '<path d="M' + x + ' ' + by + ' L' + (x-15) + ' ' + by + ' L' + x + ' ' + (by-h) + ' L' + (x+15) + ' ' + by + ' Z" ' + gl + ' opacity="0.82"/>';
          sp += '<path d="M' + x + ' ' + (by-h) + ' L' + x + ' ' + by + '" stroke="#fff" stroke-width="1" opacity="0.25"/>';
        });
        return sp;
      }
      case 'city': { // Neon City: bygninger med oplyste vinduer
        var bd = '';
        var blds = [[34,92,46,92],[98,58,56,126],[170,82,50,102],[236,52,50,132]];
        blds.forEach(function (b) {
          var x=b[0], y=b[1], w=b[2], h=b[3];
          bd += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4" fill="' + shade(a,.45) + '" opacity="0.75"/>';
          for (var r=0;r<3;r++) for (var c=0;c<2;c++) {
            bd += '<rect x="' + (x+9+c*22) + '" y="' + (y+14+r*28) + '" width="10" height="14" rx="2" ' + gl + ' opacity="0.85"/>';
          }
        });
        return bd;
      }
      case 'garden': { // Sky Garden: traeer over en groen flade
        var gr = '<ellipse cx="160" cy="176" rx="132" ry="16" fill="' + a + '" opacity="0.14"/>';
        var trees = [[72,152,34],[150,142,46],[230,152,34],[110,162,26],[200,162,26]];
        trees.forEach(function (t) {
          var x=t[0], by=t[1], s=t[2];
          gr += '<rect x="' + (x-4) + '" y="' + (by-2) + '" width="8" height="24" rx="2" fill="' + shade(a,.35) + '" opacity="0.85"/>';
          gr += '<path d="M' + x + ' ' + (by-s) + ' L' + (x-s*0.72).toFixed(0) + ' ' + by + ' L' + (x+s*0.72).toFixed(0) + ' ' + by + ' Z" ' + gl + ' opacity="0.85"/>';
        });
        return gr;
      }
      default: // social: ring af pæle om centrum
        var ring = '';
        for (var j = 0; j < 8; j++) {
          var ang = (j / 8) * Math.PI * 2 - Math.PI / 2;
          var rx = 160 + Math.cos(ang) * 96, ry = 108 + Math.sin(ang) * 58;
          ring += '<rect x="' + (rx-5).toFixed(1) + '" y="' + (ry-16).toFixed(1) + '" width="10" height="32" rx="4" ' + gl + ' opacity="0.8"/>';
        }
        return ring +
          '<circle cx="160" cy="108" r="20" stroke="' + a + '" stroke-width="3" fill="none" opacity="0.6"/>' +
          '<circle cx="160" cy="108" r="7" ' + gl + '/>';
    }
  }

  function iconPlay() {
    return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  }

  // --- Svaevende + roterende baggrunds-logoer (liv, ikke tekst) ---
  // Yderste .glyph driver TRANSLATE (drift); inderste <i> driver ROTATE (spin).
  // Drift- og spin-varighed er uafhaengige. Dybde (0=fjern,1=naer) styrer
  // stoerrelse, opacity, blur og fart samtidigt -> parallaks. Alt deterministisk.
  (function glyphs() {
    var bg = document.getElementById('bg');
    if (!bg) return;

    var GLYPH_SVG =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 1.5 L13.4 9 L19.8 4.2 L15 10.6 L22.5 12 L15 13.4 L19.8 19.8 L13.4 15 L12 22.5 L10.6 15 L4.2 19.8 L9 13.4 L1.5 12 L9 10.6 L4.2 4.2 L10.6 9 Z" fill="currentColor"/>' +
      '</svg>';

    var HUES = ['#7c5cff', '#4d7cff', '#38e1ff']; // violet, indigo, cyan
    var DRIFT_CLASS = ['', ' dB', ' dC'];          // matcher CSS driftA/B/C

    // 5x3 pseudo-grid (15 celler); spring en over -> 14 logoer spredt bredt.
    var COLS = 5, ROWS = 3, SKIP = 7; // celle 7 udelades for asymmetri
    function lerp(a, b, t) { return a + (b - a) * t; }

    var n = 0; // sekventielt index for deterministisk variation
    var cell = 0;
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        if (cell === SKIP) { cell++; continue; }

        // Deterministisk jitter pr. celle (ingen Math.random) - bryder gitteret.
        var jx = ((cell * 53) % 17) - 8;   // ~ -8..8 %
        var jy = ((cell * 37) % 13) - 6;   // ~ -6..6 %
        var left = (col + 0.5) / COLS * 100 + jx;     // % paa tvaers
        var top  = (row + 0.5) / ROWS * 100 + jy;     // % lodret
        if (left < 2) left = 2; if (left > 96) left = 96;
        if (top  < 2) top  = 2; if (top  > 95) top  = 95;

        // Dybde 0..1, varieret men deterministisk (golden-ish step).
        var depth = ((n * 0.3819) % 1);

        // Parallaks: naer = stor/skarp/lysere/hurtigere; fjern = lille/sloeret/svag/langsom.
        var size    = Math.round(lerp(26, 76, depth));        // 26..76 px
        var opacity = (lerp(0.04, 0.14, depth)).toFixed(3);   // < 0.16
        var blur    = (lerp(6, 0.4, depth)).toFixed(2);       // 6px fjern -> 0.4px naer
        var drift   = (lerp(40, 18, depth)).toFixed(1);       // 40s fjern -> 18s naer
        var spin    = (lerp(60, 24, depth)).toFixed(1);       // 60s fjern -> 24s naer
        var driftDelay = -(n * 2.7).toFixed(2);               // spred faserne
        var spinDelay  = -(n * 3.5).toFixed(2);
        var col_ = HUES[n % HUES.length];
        var rev  = (n % 2 === 1);                              // hver anden modsat
        var driftCls = DRIFT_CLASS[n % DRIFT_CLASS.length];

        // Yderste: position, stoerrelse, farve, drift-varighed/forsinkelse.
        var d = document.createElement('div');
        d.className = 'glyph' + driftCls;
        d.style.cssText =
          'top:' + top.toFixed(2) + '%;' +
          'left:' + left.toFixed(2) + '%;' +
          'width:' + size + 'px;' +
          'height:' + size + 'px;' +
          'color:' + col_ + ';' +
          'opacity:' + opacity + ';' +
          'animation-duration:' + drift + 's;' +
          'animation-delay:' + driftDelay + 's;';

        // Inderste: kun rotation (uafhaengig fart/retning) + dybde-blur.
        var inner = document.createElement('i');
        inner.style.cssText =
          'filter:blur(' + blur + 'px);' +
          'animation-duration:' + spin + 's;' +
          'animation-delay:' + spinDelay + 's;' +
          (rev ? 'animation-direction:reverse;' : '');
        inner.innerHTML = GLYPH_SVG;

        d.appendChild(inner);
        bg.appendChild(d);

        n++;
        cell++;
      }
    }
  })();

  // --- Smaa farve-helpers ---
  function rgba(hex, a) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex || ''); if (!m) return 'rgba(124,92,255,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')';
  }
  function shade(hex, f) { // bland mod sort (f = andel original)
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex || ''); if (!m) return '#1a1530';
    var n = parseInt(m[1], 16);
    var r = Math.round(((n>>16)&255) * f), g = Math.round(((n>>8)&255) * f), b = Math.round((n&255) * f);
    return '#' + ((1<<24) + (r<<16) + (g<<8) + b).toString(16).slice(1);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  }
})();
