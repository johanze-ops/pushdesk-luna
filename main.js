// PushDesk for LUNA: DOM and wiring. Listens to the Push through LUNA's own MIDI input (so
// this page never opens CoreMIDI itself), hands each message to the Surface (logic.js), and
// draws the eight strips the encoders are driving in LUNA's editor panel.

const $ = (id) => document.getElementById(id);
const L = AddOnLogic;

let luna, session, surface, input, midiOut, fader, leds;
let stopListening = null;
let stopFader = null;
let releases = [];
const keep = (u) => u && releases.push(u);
const release = () => { for (const u of releases) { try { u(); } catch { /* gone */ } } releases = []; };
let stripUnsubs = [];
let paintQueued = false;

// ---------- display ----------
function buildStrips() {
  const root = $('strips');
  root.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const el = document.createElement('div');
    el.className = 'strip empty';
    el.innerHTML = `<span class="enc">${i + 1}</span><div class="colour"></div><div class="name">—</div><div class="value"></div><div class="body"><div class="bar"><div class="fill"></div><div class="pan" hidden></div></div><div class="meter"><div class="lvl"></div></div></div>`;
    root.appendChild(el);
  }
}

const hex = (c) => (typeof c === 'number' && c >= 0 ? `#${(c & 0xffffff).toString(16).padStart(6, '0')}` : '#444');

// ---------- the Push screen, via the companion app ----------
// An Add On has no USB, so companion/pushdesk_luna_screen.py draws the screen. LUNA lets an
// Add On page reach localhost on any port without asking. If the companion isn't running,
// requests fail quietly and are retried every few seconds.
const SCREEN_URL = 'http://127.0.0.1:47829';
const screen = { lastState: '', retryAt: 0, meterTimer: null, online: false };
async function postScreen(path, body) {
  if (Date.now() < screen.retryAt) return;
  try {
    await fetch(SCREEN_URL + path, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
    screen.failures = 0;
    if (!screen.online) { screen.online = true; showHelperHint(); schedulePaint(); }
  } catch {
    screen.retryAt = Date.now() + 3000;
    screen.failures = (screen.failures ?? 0) + 1;
    if (screen.online) { screen.online = false; schedulePaint(); }
    showHelperHint();
  }
}

/** When the Push is here but no helper answers, say how to install it (once). */
function showHelperHint() {
  const pushHere = $('push').className === 'ok';
  $('helper').hidden = screen.online || !pushHere || (screen.failures ?? 0) < 2;
}
function publishScreen(force = false) {
  if (!surface) return;
  const body = JSON.stringify(L.displayState(surface, fader).state);
  if (!force && body === screen.lastState) return;
  screen.lastState = body;
  postScreen('/state', body);
}
function publishMeters() {
  if (!surface) return;
  postScreen('/meters', JSON.stringify(L.displayState(surface, fader).meters));
}
function scheduleMeters() {
  if (screen.meterTimer) return;
  screen.meterTimer = setTimeout(() => { screen.meterTimer = null; publishMeters(); }, 66);
}

/** Light the Push buttons that do something (PushDesk's scheme). */
function updateLeds({ off = false } = {}) {
  if (leds) leds.update(L.buttonLeds(surface, fader, { off }), L.padLeds(surface, { off }));
}

function paint() {
  paintQueued = false;
  updateLeds();
  publishScreen();
  if (!surface) return;
  $('mode').textContent = L.MODE_LABEL[surface.mode];
  const n = surface.tracks().length;
  if (L.PLUG_MODES.includes(surface.mode)) {
    const e = surface.plug?.effect;
    const count = surface.plugParams().length;
    const pages = Math.max(1, Math.ceil(count / 8));
    $('bank').textContent = e ? `${surface.plug.channel.name.value ?? ''} › ${e.pluginName.value ?? 'plugin'} · page ${surface.plugPage + 1}/${pages}${surface.hasFavourites() ? (surface.favOn ? ' · favourites' : ' · all') : ''}` : 'No plugin: open one in LUNA, or press a button under the display';
  } else if (surface.activePins().size) {
    const free = surface.freeTracks().length, w = surface.bankWidth(), pinned = surface.activePins().size;
    $('bank').textContent = `${pinned} pinned · ${w && free ? `the others ${surface.bankStart + 1}–${Math.min(surface.bankStart + w, free)} of ${free}` : 'no free strips'}`;
  } else {
    $('bank').textContent = n ? `Tracks ${surface.bankStart + 1}–${Math.min(surface.bankStart + 8, n)} of ${n}${surface.pins.size ? ' · pins off (tap Layout)' : ''}` : 'No tracks';
  }
  const f = session?.focusedTrack.value;
  $('focus').innerHTML = f ? 'Touch strip: <b></b>' : '';
  if (f) $('focus').querySelector('b').textContent = f.name.value ?? '';
  // The pin hint leads (the line is cut off at the panel's width): how to pin until something
  // is pinned, then how to switch the pins off and on.
  const pinHint = surface.pins.size
    ? 'Pins: hold Layout + a select pad to pin / unpin · tap Layout: all tracks ↔ pins'
    : 'Pin a track to its strip: hold Layout and press its select pad';
  $('note').textContent = surface.notice ?? (surface.layoutHeld
    ? 'Layout held: press a select pad to pin that track to its strip, or to unpin it'
    : `${pinHint} · encoders: tracks · ◀ ▶: bank · a/b: FADER / PAN · d: PLUG · pads: select / mute / solo / rec · Shift: fine · under the display: inserts · ↑: favourites · ↓: FADER ↔ last`);
  const fd = $('fader');
  if (!fader) { fd.textContent = ''; }
  else {
    const name = fader.track?.name.value ?? '—';
    fd.textContent = `Fader: ${name}${fader.locked ? ' · LOCK' : ''}${fader.motorsOn ? '' : ' · MOTOR OFF'}${fader.touched ? ' · TOUCH' : ''}`;
  }
  $('push').title = screen.online ? 'Push screen: companion running' : 'Push screen: companion not running (companion/pushdesk_luna_screen.py)';
  const els = $('strips').children;
  surface.strips().forEach((s, i) => {
    const el = els[i];
    el.classList.toggle('empty', !!s.empty);
    el.classList.toggle('touched', !!s.touched);
    el.classList.toggle('selected', !!s.selected);
    el.classList.toggle('pinned', !!s.pinned);
    el.querySelector('.name').textContent = s.empty ? (s.missing !== undefined ? `${s.missing || 'Pinned track'} (deleted)` : '—') : s.name;
    el.querySelector('.value').textContent = s.empty ? '' : s.display;
    el.querySelector('.colour').style.background = s.empty ? '#333' : s.param ? 'var(--accent)' : hex(s.color);
    const fill = el.querySelector('.fill'), pan = el.querySelector('.pan');
    const isPan = surface.mode === 'pan';
    fill.hidden = isPan; pan.hidden = !isPan || s.empty;
    if (!isPan) fill.style.transform = `scaleY(${s.empty ? 0 : s.value})`;
    else pan.style.left = `${(s.value ?? 0.5) * 100}%`;
  });
}

function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paint);
  setTimeout(() => { if (paintQueued) paint(); }, 100); // rAF stops while hidden; keep state fresh
}

/** Subscribe to what the eight strips show; called again on bank, mode or track changes. */
async function watchBank() {
  for (const u of stripUnsubs) { try { u(); } catch { /* gone */ } }
  stripUnsubs = [];
  const els = $('strips').children;
  if (L.PLUG_MODES.includes(surface.mode)) {
    for (const st of surface.strips()) {
      if (st.empty) continue;
      const p = surface.targetFor(st.index);
      if (p) stripUnsubs.push(p.normalized.onChange(schedulePaint), p.display.onChange(schedulePaint));
    }
    // A favourites file can follow a switch on the plugin (@if EQ Select = 560L): when any
    // parameter's value changes, check whether the page layout changed.
    for (const p of surface.plug?.effect?.params ?? []) stripUnsubs.push(p.display.onChange(() => surface.onChange()));
    for (let i = 0; i < 8; i++) els[i].querySelector('.lvl').style.transform = 'scaleY(0)';
    schedulePaint();
    return;
  }
  const bank = surface.bank(); // with pins: 8 columns, null where a pinned track is gone
  await Promise.all(bank.map((t) => t?.loadStrip().catch(() => undefined)));
  bank.forEach((t, i) => {
    if (!t) { els[i].querySelector('.lvl').style.transform = 'scaleY(0)'; return; }
    const c = surface.controlFor(t);
    stripUnsubs.push(t.name.onChange(schedulePaint), t.color.onChange(schedulePaint));
    // pad lights follow mute, solo and record arm
    for (const p of [t.mute?.real, t.solo?.real, t.recordEnabled]) if (p?.onChange) stripUnsubs.push(p.onChange(schedulePaint));
    if (c) stripUnsubs.push(c.normalized.onChange(schedulePaint), c.display.onChange(schedulePaint));
    const lvl = els[i].querySelector('.lvl');
    try { stripUnsubs.push(t.meter.onChange(() => { lvl.style.transform = `scaleY(${Math.min(1, t.meter.max)})`; scheduleMeters(); })); } catch { /* no meter */ }
  });
  for (let i = bank.length; i < 8; i++) els[i].querySelector('.lvl').style.transform = 'scaleY(0)';
  schedulePaint();
}

// ---------- the Push ----------
function pushStatus(ok, text) {
  $('push').className = ok ? 'ok' : 'off';
  $('push').textContent = text;
}

/** Find the Push's Live Port among LUNA's MIDI devices and listen to it (again after hot-plug). */
function attachPush() {
  if (stopListening) { try { stopListening(); } catch { /* gone */ } stopListening = null; }
  const dev = luna.midiDevices.items.find((d) => d.name.value === L.PUSH.PORT && d.inputPort);
  if (!dev) { leds = null; pushStatus(false, 'Push not found — is it plugged in?'); return; }
  // Our palette entries first (as PushDesk), then the button lights.
  if (dev.outputPort) {
    for (const bytes of L.paletteSysEx()) midiOut.sendSysExToOutput(dev, bytes).catch(() => undefined);
    leds = new L.Leds(([a, b, c]) => { midiOut.sendMidiToOutput(dev, a, b, c).catch(() => undefined); });
    updateLeds();
  }
  stopListening = input.listen(dev, (m) => {
    // Delete (CC 118) locks the motor fader to its track, as PushDesk does.
    if (m.type === 'controlChange' && m.data1 === L.FADER.LOCK_CC) { if (m.data2 > 0) fader?.toggleLock(); return; }
    if (surface) surface.handleMidi(m);
  });
  pushStatus(true, 'Push 2');
}

/** The DIY motor fader: listen to it, and drive its motor through LUNA's MIDI output. */
function attachFader() {
  if (stopFader) { try { stopFader(); } catch { /* gone */ } stopFader = null; }
  fader?.release();
  fader = null;
  const dev = luna.midiDevices.items.find((d) => d.name.value === L.FADER.PORT && d.inputPort);
  if (!dev || !session) { schedulePaint(); return; }
  fader = new L.MotorFader(session, (a, b, c) => { midiOut.sendMidiToOutput(dev, a, b, c).catch(() => undefined); }, { onChange: schedulePaint });
  stopFader = input.listen(dev, (m) => fader?.handleMidi(m));
  fader.follow({ now: true });
}

// ---------- plugins ----------
/**
 * Keep the row under the display in step with the selected track's plugins: re-read them
 * when a slot is added or removed, or a plugin is put in, swapped or taken out of one.
 */
let slotUnsubs = [];
async function watchSlots() {
  for (const u of slotUnsubs) { try { u(); } catch { /* gone */ } }
  slotUnsubs = [];
  const track = session?.focusedTrack.value;
  if (!surface) return;
  if (!track) { surface.refreshSlots(); return; }
  try { await track.effects.load(); } catch { /* none */ }
  if (track !== session.focusedTrack.value) return;
  let timer = null;
  const again = () => { clearTimeout(timer); timer = setTimeout(() => surface.refreshSlots(track), 150); };
  slotUnsubs.push(track.effects.onChange(() => { again(); watchSlots(); }));
  for (const e of track.effects.items) {
    for (const p of [e.pluginName, e.loaded]) if (p?.onChange) slotUnsubs.push(p.onChange(again));
  }
  await surface.refreshSlots(track);
}

/** favourites/<plugin name>.txt shipped with the Add On (PushDesk's format), or null. */
function loadFavourites(name) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `favourites/${encodeURIComponent(name)}.txt`);
    xhr.onload = () => resolve(xhr.status === 200 || (xhr.status === 0 && xhr.responseText) ? xhr.responseText : null); // raw: @if sections are decided live
    xhr.onerror = () => resolve(null);
    xhr.send();
  });
}

/** When a plugin window opens in LUNA, the encoders follow it (as Push does in Live). */
let openWindows = new Set();
function watchPluginWindows() {
  const key = (w) => `${w.sessionUid}/${w.channelUid}/${w.slot}`;
  const update = () => {
    const now = luna.gui.pluginWindows.value ?? [];
    const fresh = now.filter((w) => !openWindows.has(key(w)) && w.sessionUid === session?.id);
    openWindows = new Set(now.map(key));
    const w = fresh.at(-1);
    if (w && surface) surface.focusPlugin(w.channelUid, w.slot);
  };
  luna.gui.pluginWindows.onChange(update);
  openWindows = new Set((luna.gui.pluginWindows.value ?? []).map(key));
}

// ---------- session ----------
async function bindSession() {
  const next = luna.sessions.current();
  if (next && next === session && surface) return;
  if (surface) surface.releaseAll();
  release();
  session = next;
  surface = null;
  if (!session) { $('bank').textContent = 'Open a session in LUNA'; return; }
  await session.ready();
  let lastBankKey = '';
  surface = new L.Surface(session, {
    onChange: () => {
      const key = L.PLUG_MODES.includes(surface.mode)
        ? `plug:${surface.plug?.effect?.path}:${surface.plugPage}:${surface.favOn}:${surface.strips().map((x) => x.name).join('|')}`
        : `${surface.mode}:${surface.bank().map((t) => t?.id ?? '-').join(',')}`;
      if (key !== lastBankKey) { lastBankKey = key; watchBank(); }
      schedulePaint();
    },
  });
  surface.loadFavourites = loadFavourites;
  // Pinned tracks are saved with the session (not an undo step).
  const mine = surface, inSession = session;
  let saveTimer = null;
  surface.onPinsChange = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => L.savePins(inSession, mine.pinsData()).catch((e) => console.warn('PushDesk: pins not saved', e)), 300);
  };
  try {
    const saved = await L.loadPins(session);
    if (saved && surface === mine) surface.setPins(saved);
  } catch (e) { console.warn('PushDesk: no saved pins', e); }
  if (surface !== mine) return; // the session changed while the pins loaded
  keep(session.tracks.onChange(() => { surface.onChange(); fader?.checkLock(); }));
  keep(session.focusedTrack.onChange(() => { surface.followSelection(); surface.followPlugin(); watchSlots(); schedulePaint(); fader?.follow(); }));
  watchSlots();
  surface.onChange();
  if (luna.midiDevices.items.length) attachFader();
}

async function connect() {
  buildStrips();
  $('helperCopy').onclick = async () => {
    const cmd = $('helperCmd').textContent;
    try { await navigator.clipboard.writeText(cmd); $('helperCopy').textContent = 'Copied'; }
    catch { getSelection().selectAllChildren($('helperCmd')); $('helperCopy').textContent = 'Press ⌘C'; }
    setTimeout(() => { $('helperCopy').textContent = 'Copy'; }, 2500);
  };
  // Double-click the mode label to reload the page with the latest code (no LUNA restart).
  $('mode').title = 'Double-click to reload PushDesk';
  $('mode').ondblclick = () => { surface?.releaseAll(); fader?.release(); location.reload(); };
  for (;;) {
    try { luna = await Luna.connect(); break; } catch (e) {
      $('bank').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  input = new Luna.MidiInput(luna);
  midiOut = new Luna.SendMidi(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  await bindSession();
  await luna.midiDevices.load();
  const devicesChanged = () => {
    attachPush();
    const has = !!luna.midiDevices.items.find((d) => d.name.value === L.FADER.PORT && d.inputPort);
    if (has !== !!fader) attachFader();
  };
  luna.midiDevices.onChange(devicesChanged);
  if (await luna.gui.available()) { try { await luna.gui.watchPluginWindows(); watchPluginWindows(); } catch { /* older LUNA */ } }
  attachPush();
  attachFader();
  // Never leave a touch held: a held touch writes automation.
  const letGo = () => { surface?.releaseAll(); fader?.release(); updateLeds({ off: true }); };
  setInterval(() => updateLeds(), 5000); // resend now and then: another app may have written over them
  // A Push (or fader) switched on after LUNA started can join the device list before its name
  // is filled in, so the change above misses it. Keep looking while one isn't attached.
  setInterval(() => {
    const found = (port) => luna.midiDevices.items.some((d) => d.name.value === port && d.inputPort);
    if (!stopListening && found(L.PUSH.PORT)) attachPush();
    if (!fader && session && found(L.FADER.PORT)) attachFader();
  }, 2000);
  setInterval(() => { publishScreen(true); publishMeters(); }, 1000); // the screen's heartbeat
  window.addEventListener('pagehide', letGo);
  luna.status.onChange(() => { if (luna.status.value === 'disconnected') { letGo(); pushStatus(false, 'LUNA disconnected'); } });
}

connect();
