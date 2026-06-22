// chat.js
// In-game chat overlay for NovaVerse. Ren browser ES-modul - INGEN three.js.
//
// Brug (integratoren wirer net.js + main.js + index.html):
//   import { createChat } from './chat.js';
//   const chat = createChat({ onSend: (text) => net.sendChat(text) });
//   // net.onChat = (msg) => chat.receive(msg);  // msg = {id,name,color,text}
//   // i spil-loopet: if (chat.isTyping()) { ...ignorer WASD/bevaegelse... }
//   // Enter naar input IKKE er fokuseret -> chat.focusInput() (eller automatisk; se nedenfor)
//
// Returnerer: { receive(msg), focusInput(), isTyping() }
//   - receive(msg): tilfoejer en besked til loggen. msg = {id,name,color,text}.
//       name farves med msg.color. id bruges ikke til visning men beholdes.
//   - focusInput(): fokuserer kompositions-feltet.
//   - isTyping(): true naar feltet er fokuseret (spil-loopet ignorerer bevaegelse).
//
// Tastatur (haandteres internt af dette modul):
//   - Enter naar feltet IKKE er fokuseret -> fokuser feltet (start at skrive).
//   - Enter MENS fokuseret -> send trimmet ikke-tom tekst via onSend, ryd, blur.
//   - Escape -> blur feltet.
// WASD fanges ALDRIG globalt: kun <input> forbruger tastetryk (det har fokus).
//
// Design-DNA (matcher index.html / hud.css):
//   moerkt glas rgba(12,14,22,.6), backdrop-blur, hairline rgba(255,255,255,.14),
//   rundet 14px, Inter/system-ui, tekst #f4f6ff, dæmpet #7c8398, aurora #7c5cff.

export function createChat({ onSend } = {}) {
  // --- Konstanter ---
  const MAX_MESSAGES = 50; // cap paa DOM-noder i loggen (sidste ~50)
  const MAX_INPUT_LEN = 200; // matcher serverens MaxChatLen

  // --- Engangs-injektion af styles (scoped via .nv-chat* klasser) ---
  injectStylesOnce();

  // --- Byg DOM ---
  // Rod-laget fylder ikke skaermen og fanger ikke pointer-events; KUN panelet
  // er interaktivt. Saa canvas'en under chatten virker stadig (klik/drag/scroll).
  const root = document.createElement('div');
  root.className = 'nv-chat';
  root.setAttribute('aria-live', 'polite');

  const panel = document.createElement('div');
  panel.className = 'nv-chat-panel';

  const log = document.createElement('div');
  log.className = 'nv-chat-log';
  log.setAttribute('role', 'log');

  const form = document.createElement('form');
  form.className = 'nv-chat-form';
  form.autocomplete = 'off';

  const input = document.createElement('input');
  input.className = 'nv-chat-input';
  input.type = 'text';
  input.maxLength = MAX_INPUT_LEN;
  input.placeholder = 'Skriv en besked...';
  input.setAttribute('aria-label', 'Chat-besked');
  // Robusthed: undgaa at mobil-tastatur foreslaar/auto-retter aggressivt.
  input.autocomplete = 'off';
  input.autocapitalize = 'sentences';
  input.spellcheck = false;

  const hint = document.createElement('div');
  hint.className = 'nv-chat-hint';
  hint.textContent = 'Tryk Enter for at chatte';

  form.appendChild(input);
  panel.appendChild(log);
  panel.appendChild(form);
  panel.appendChild(hint);
  root.appendChild(panel);
  document.body.appendChild(root);

  // --- Hjaelpere ---
  function isTyping() {
    return document.activeElement === input;
  }

  function focusInput() {
    input.focus();
  }

  // sanitize: trim. (Vis-side; serveren capper laengden autoritativt.)
  function trim(s) {
    return (s == null ? '' : String(s)).trim();
  }

  // receive: tilfoej en indkommende besked til loggen.
  // msg = { id, name, color, text }. name farves med color.
  function receive(msg) {
    if (!msg) return;
    const name = msg.name != null ? String(msg.name) : 'anon';
    const text = msg.text != null ? String(msg.text) : '';
    if (text === '') return;
    const color = isSafeColor(msg.color) ? msg.color : '#f4f6ff';

    const stuckToBottom = isScrolledToBottom();

    const row = document.createElement('div');
    row.className = 'nv-chat-msg';

    const who = document.createElement('span');
    who.className = 'nv-chat-name';
    who.style.color = color;
    who.textContent = name; // textContent => ingen HTML-injektion

    const sep = document.createElement('span');
    sep.className = 'nv-chat-sep';
    sep.textContent = ': ';

    const body = document.createElement('span');
    body.className = 'nv-chat-text';
    body.textContent = text; // textContent => ingen HTML-injektion

    row.appendChild(who);
    row.appendChild(sep);
    row.appendChild(body);
    log.appendChild(row);

    // Cap DOM'en til de sidste MAX_MESSAGES.
    while (log.childElementCount > MAX_MESSAGES) {
      log.removeChild(log.firstElementChild);
    }

    // Auto-scroll til nyeste hvis brugeren allerede var i bunden (eller skriver).
    if (stuckToBottom || isTyping()) {
      scrollToBottom();
    }
  }

  function isScrolledToBottom() {
    // 4px slop.
    return log.scrollHeight - log.scrollTop - log.clientHeight < 4;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  // send: kald onSend med trimmet ikke-tom tekst, ryd og blur.
  function send() {
    const text = trim(input.value);
    input.value = '';
    if (text === '') {
      input.blur();
      return;
    }
    if (typeof onSend === 'function') {
      try {
        onSend(text);
      } catch (err) {
        // Spillet maa ikke crashe hvis kalderens onSend fejler.
      }
    }
    input.blur();
  }

  // --- Tastatur ---
  // Enter naar feltet IKKE er fokuseret -> fokuser (start at skrive).
  // Vi lytter paa document i capture-fasen, men forbruger KUN Enter naar
  // intet andet inputfelt er fokuseret, saa vi aldrig staaler andres tastetryk.
  function onDocKeydown(e) {
    if (e.key !== 'Enter') return;
    if (e.repeat) return;
    if (isTyping()) return; // form-handler tager sig af send mens fokuseret
    if (isEditableTarget(e.target)) return; // respekter andre inputs/contenteditable
    // Aabn chatten.
    e.preventDefault();
    focusInput();
  }

  // I selve feltet: Enter sender, Escape blurrer. stopPropagation saa spillets
  // egne keydown-handlers (paa window/document) ikke ogsaa reagerer paa skrift.
  function onInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.blur();
      e.stopPropagation();
    } else {
      // WASD/space osv. mens man skriver maa ikke naa spil-loopet.
      e.stopPropagation();
    }
  }

  function onSubmit(e) {
    // Backup-sti hvis Enter udloeser form-submit i stedet for keydown.
    e.preventDefault();
    send();
  }

  document.addEventListener('keydown', onDocKeydown, true);
  input.addEventListener('keydown', onInputKeydown);
  form.addEventListener('submit', onSubmit);

  // --- Offentligt API ---
  return {
    receive,
    focusInput,
    isTyping,
  };
}

// isSafeColor: tillad kun simple farve-strenge (hex / rgb / navngivne ord),
// saa en ondsindet "color" ikke kan smugle CSS ind via style.
function isSafeColor(c) {
  if (typeof c !== 'string') return false;
  const s = c.trim();
  if (s === '') return false;
  // hex #rgb / #rrggbb / #rrggbbaa
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return true;
  // rgb()/rgba()
  if (/^rgba?\(\s*[\d.\s,%/]+\)$/.test(s)) return true;
  // simple navngivne farver (bogstaver)
  if (/^[a-zA-Z]{1,20}$/.test(s)) return true;
  return false;
}

// isEditableTarget: er event-targettet et andet redigerbart element?
function isEditableTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

// injectStylesOnce: indsaetter chat-stylesheet'et een gang i <head>.
function injectStylesOnce() {
  if (document.getElementById('nv-chat-styles')) return;
  const style = document.createElement('style');
  style.id = 'nv-chat-styles';
  style.textContent = `
.nv-chat {
  position: fixed;
  left: 0; bottom: 0;
  width: 0; height: 0;
  z-index: 40;
  pointer-events: none; /* rod-laget fanger ikke klik; canvas under virker */
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.nv-chat-panel {
  position: fixed;
  left: 16px;
  bottom: 64px; /* over "Forlad spil"-knappen (left:16 bottom:16) */
  width: 320px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 14px;
  background: rgba(12,14,22,.6);
  border: 1px solid rgba(255,255,255,.14);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
  box-shadow: 0 10px 30px rgba(0,0,0,.35);
  pointer-events: auto; /* KUN panelet er interaktivt */
  color: #f4f6ff;
}
.nv-chat-log {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  font-size: 13px;
  line-height: 1.4;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(124,92,255,.5) transparent;
}
.nv-chat-log::-webkit-scrollbar { width: 6px; }
.nv-chat-log::-webkit-scrollbar-thumb {
  background: rgba(124,92,255,.45);
  border-radius: 3px;
}
.nv-chat-log::-webkit-scrollbar-track { background: transparent; }
.nv-chat-msg {
  word-break: break-word;
  overflow-wrap: anywhere;
}
.nv-chat-name {
  font-weight: 600;
  color: #f4f6ff;
}
.nv-chat-sep { color: #7c8398; }
.nv-chat-text { color: #f4f6ff; }
.nv-chat-form { display: flex; }
.nv-chat-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(0,0,0,.25);
  color: #f4f6ff;
  font: 500 13px/1.2 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.nv-chat-input::placeholder { color: #7c8398; }
.nv-chat-input:focus {
  border-color: rgba(124,92,255,.7);
  box-shadow: 0 0 0 3px rgba(124,92,255,.18);
  background: rgba(0,0,0,.35);
}
.nv-chat-hint {
  font-size: 11px;
  color: #7c8398;
  letter-spacing: .01em;
  user-select: none;
}
`;
  document.head.appendChild(style);
}
