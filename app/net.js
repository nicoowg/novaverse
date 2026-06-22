// net.js
// WebSocket netvaerksklient for NovaVerse med et FAST JSON-protokol-format.
// Ingen three.js noedvendig her - ren afhaengighedslet modul.
//
// Brug: const net = createNet({ game, name, color, skin, hair, preset, items });
//   - net.sendInput(seq, dir, jump, yaw) ~30 Hz fra spil-loopet
//   - net.getPlayers() til at rendere fjernspillere
//   - net.onWelcome / net.onState / net.onLeave callbacks
//   - net.ping for et glattet latens-estimat (ms)
//
// Protokol (skal matche serveren praecist):
//   Connect: ws://localhost:8090/ws?game=<id>&name=<name>&color=<hex>&skin=<id>&hair=<id>&preset=<id>&items=<csv>
//     (items er komma-separerede kosmetik-id'er paa traaden)
//   Server -> {"type":"welcome","id":"<playerId>"}
//   Client -> {"type":"input","seq":<int>,"dir":[<x>,<z>],"jump":<bool>,"yaw":<float>}  ~30 Hz
//   Server -> {"type":"state","tick":<int>,"players":[{id,name,color,skin,hair,preset,items,pos:[x,y,z],yaw}]}  ~20 Hz
//   Server -> {"type":"leave","id":"..."}

// Server-URL fra runtime-config (golive overskriver til den offentlige tunnel ved publish).
const WS_BASE = (typeof window !== 'undefined' && window.NOVA_CONFIG && window.NOVA_CONFIG.ws)
  ? window.NOVA_CONFIG.ws
  : 'ws://localhost:8090/ws';

export function createNet({ game, name, color, skin, hair, preset, items }) {
  // --- Intern state ---
  let ws = null;
  let _connected = false; // sandt mellem onopen og onclose
  let _selfId = null; // saettes naar welcome ankommer
  let _latestState = null; // sidste state-besked (raa objekt)

  // Ping-estimat: vi maaler intervallet mellem to paa-hinanden-foelgende
  // state-snapshots og glatter det. Dette er IKKE en aegte RTT - serveren
  // ekkoer ikke vores input - men det giver et stabilt, altid-til-stede tal
  // som proxy for netvaerks-rytmen (snapshot-interval i ms).
  let _ping = 0; // glattet snapshot-interval (ms)
  let _lastStateTime = 0; // performance.now() for forrige state
  const PING_SMOOTHING = 0.2; // EMA-faktor (0..1); hoejere = mere reaktiv

  // Tidspunkt for seneste sendte input (efter seq). Holdes selvom vi ikke
  // bruger det til RTT - nyttigt til debugging og evt. fremtidig brug.
  let _lastInputSentTime = 0;

  // Reconnect: hvis forbindelsen lukker (eller aldrig naaede op foer scenen var
  // bygget), proever vi igen. Saa en sen/genstartet server stadig bliver samlet op.
  let _manualClose = false;
  let _reconnectTimer = null;

  // Callback-hooks - kan saettes af kalderen efter createNet().
  const hooks = {
    onWelcome: null, // (id) => {}
    onState: null,   // (stateMsg) => {}
    onLeave: null,   // (id) => {}
    onChat: null,    // ({id,name,color,text}) => {}
  };

  // --- Opret forbindelsen ---
  function buildUrl() {
    const params = new URLSearchParams({
      game: game == null ? '' : String(game),
      name: name == null ? '' : String(name),
      color: color == null ? '' : String(color),
      skin: skin == null ? '' : String(skin),
      hair: hair == null ? '' : String(hair),
      preset: preset == null ? '' : String(preset),
      items: Array.isArray(items) ? items.join(',') : (items == null ? '' : String(items)),
    });
    return `${WS_BASE}?${params.toString()}`;
  }

  function connect() {
    try {
      ws = new WebSocket(buildUrl());
    } catch (err) {
      // Hvis selve konstruktionen fejler, forbliver vi single-player.
      _connected = false;
      ws = null;
      return;
    }

    ws.onopen = () => {
      _connected = true;
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        // Ignorer beskeder vi ikke kan parse - vaer robust.
        return;
      }
      handleMessage(msg);
    };

    ws.onerror = () => {
      // Fejl haandteres stille; onclose foelger og rydder op.
      // Spillet koerer videre single-player. Ingen reconnect-spam.
    };

    ws.onclose = () => {
      _connected = false;
      if (!_manualClose) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(connect, 800);
      }
    };
  }

  // --- Indkommende beskeder ---
  function handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'welcome': {
        _selfId = msg.id != null ? msg.id : null;
        if (typeof hooks.onWelcome === 'function') hooks.onWelcome(_selfId);
        break;
      }
      case 'state': {
        _latestState = msg;
        // Opdater snapshot-interval-pingen.
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (_lastStateTime > 0) {
          const interval = now - _lastStateTime;
          // EMA: glat det stoejende interval til et stabilt tal.
          _ping = _ping === 0 ? interval : _ping + (interval - _ping) * PING_SMOOTHING;
        }
        _lastStateTime = now;
        if (typeof hooks.onState === 'function') hooks.onState(msg);
        break;
      }
      case 'leave': {
        if (typeof hooks.onLeave === 'function') hooks.onLeave(msg.id);
        break;
      }
      case 'chat': {
        // Server-broadcast chat: {type,id,name,color,text}. Videresend raat.
        if (typeof hooks.onChat === 'function') hooks.onChat(msg);
        break;
      }
      default:
        // Ukendt type - ignorer stille.
        break;
    }
  }

  // --- Udgaaende: input ---
  // Sender en input-besked hvis forbundet. Kalderen styrer seq selv.
  function sendInput(seq, dir, jump, yaw) {
    if (!_connected || !ws || ws.readyState !== WebSocket.OPEN) return;

    // Normaliser argumenter til protokol-formatet.
    const safeDir = Array.isArray(dir) && dir.length >= 2
      ? [Number(dir[0]) || 0, Number(dir[1]) || 0]
      : [0, 0];

    const payload = {
      type: 'input',
      seq: seq | 0,
      dir: safeDir,
      jump: !!jump,
      yaw: Number(yaw) || 0,
    };

    try {
      ws.send(JSON.stringify(payload));
      _lastInputSentTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    } catch (err) {
      // Send kan fejle hvis socket lukker midt i; ignorer stille.
    }
  }

  // --- Udgaaende: chat ---
  // Sender en chat-besked til serveren, som broadcaster den til hele rummet.
  function sendChat(text) {
    if (!_connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    try {
      ws.send(JSON.stringify({ type: 'chat', text: t }));
    } catch (err) {
      // Send kan fejle hvis socket lukker midt i; ignorer stille.
    }
  }

  // --- Hjaelpere ---
  function getPlayers() {
    return _latestState && Array.isArray(_latestState.players)
      ? _latestState.players
      : [];
  }

  function isConnected() {
    return _connected;
  }

  function close() {
    _manualClose = true;
    clearTimeout(_reconnectTimer);
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        // Ignorer.
      }
    }
    ws = null;
    _connected = false;
  }

  // Start forbindelsen med det samme.
  connect();

  // --- Offentligt objekt ---
  const api = {
    sendInput,
    sendChat,
    getPlayers,
    isConnected,
    close,

    // Getters for laese-state.
    get selfId() { return _selfId; },
    get connected() { return _connected; },
    get latestState() { return _latestState; },
    get ping() { return Math.round(_ping); },

    // Settbare callback-hooks.
    get onWelcome() { return hooks.onWelcome; },
    set onWelcome(fn) { hooks.onWelcome = fn; },
    get onState() { return hooks.onState; },
    set onState(fn) { hooks.onState = fn; },
    get onLeave() { return hooks.onLeave; },
    set onLeave(fn) { hooks.onLeave = fn; },
    get onChat() { return hooks.onChat; },
    set onChat(fn) { hooks.onChat = fn; },
  };

  return api;
}
