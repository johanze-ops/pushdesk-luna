// PushDesk for LUNA: the surface logic, with no DOM, so tests run it against Luna.MockEngine.
//
// The Push 2 control map is PushDesk's, captured at the desk (PUSH/CLAUDE.md, "Push 2 control
// map"), and confirmed through LUNA's MIDI input on 2026-11-23: everything arrives on the
// Live Port, channel 1.

const PUSH = {
  PORT: 'Ableton Push 2 Live Port',
  ENCODER_CC: 71,          // 71..78, relative: 1..63 clockwise, 127..65 anticlockwise
  ENCODER_TOUCH_NOTE: 0,   // notes 0..7: finger on encoder 1..8
  STRIP_TOUCH_NOTE: 12,    // finger on the touch strip; the strip itself sends pitch bend
  KNOBSET_CC: 102,         // 102..109: the row above the display, knobsets a..h
  LOWER_ROW_CC: 20,        // 20..27: the row below the display
  PAGE_PREV_CC: 44,
  PAGE_NEXT_CC: 45,
  SHIFT_CC: 49,
  LAYOUT_CC: 31,           // Layout: hold + a select pad pins that track; tap = pins off/on (PushDesk's LAYOUTS)
  FAVOURITES_CC: 46,       // up arrow: favourites <-> the full parameter list (PushDesk)
  LAST_KNOBSET_CC: 47,     // down arrow: FADER <-> the last knobset (PushDesk)
  PAD_BASE: 36,            // pads 36..99: 36 bottom-left, +8 per row up
};
const PAD_ROWS = ['select', 'mute', 'solo', 'rec']; // the bottom four rows, as PushDesk

const MODES = ['fader', 'pan', null, 'plug', 'eq', 'dyn']; // knobsets a, b, (c: sends, later), d, e, f
const MODE_LABEL = { fader: 'FADER', pan: 'PAN', plug: 'PLUG', eq: 'EQ', dyn: 'DYN' };
const PLUG_MODES = ['plug', 'eq', 'dyn']; // modes that drive a plugin's parameters

const AddOnLogic = {
  PUSH,
  MODES,
  MODE_LABEL,

  /** A relative encoder value as a signed step. */
  delta(v) {
    return v < 64 ? v : v - 128;
  },

  /** The 14-bit touch strip position, 0..1. */
  stripPosition(lsb, msb) {
    return ((msb << 7) | lsb) / 16383;
  },

  /**
   * How far one encoder step moves a control (0..1 range). PushDesk's gearing (PUSH
   * docs/notes/12): a fader moves one step of a 1024-step table per detent, no acceleration (a
   * flick still sends 2-3 per message). Pan: about 200 steps across. Shift: a quarter of that,
   * which LUNA's float controls can take (Pro Tools' fader index could not).
   */
  step(mode, fine) {
    const coarse = mode === 'pan' ? 1 / 200 : mode === 'param' ? 1 / 400 : 1 / 1024;
    return fine ? coarse / 4 : coarse;
  },

  /** The dead-centre bend the touch strip sends as the finger lifts, before its note-off (PUSH docs/notes/02). */
  isLiftOff(lsb, msb) {
    return lsb === 0 && msb === 64;
  },

  clamp01(v) {
    return Math.min(1, Math.max(0, v));
  },

  /**
   * A channel's plugins as LUNA's mixer orders them: the console extension, the tape
   * extension, then the eight insert slots. Empty slots are left out.
   */
  orderedPlugins(channel) {
    const byId = (id) => channel.effects?.byId?.(id);
    const list = [byId('console'), byId('tape'), ...(channel.effectSlots ?? [])];
    // An insert whose plugin id is `alias.console` (or `alias.tape`) is LUNA's shortcut to the
    // console/tape extension, shown where it sits in the chain: it has no parameters of its
    // own, so the extension itself stands for it.
    return list.filter((e) => e && !e.isEmpty && !String(e.pluginId?.value ?? '').startsWith('alias.'));
  },

  /** Console and tape extensions live in LUNA's channel strip: LUNA has no plugin window for them, only a generic panel. */
  isExtension(effect) {
    return effect?.id === 'console' || effect?.id === 'tape';
  },

  /**
   * A favourites file (PushDesk's format): one parameter name per line, # comments, blanks
   * ignored. Sections can follow a switch on the plugin:
   *     @if EQ Select = 560L      (the parameter's displayed value, case ignored)
   *     ...
   *     @else
   *     ...
   *     @end
   * `valueOf(name)` gives a parameter's current displayed value.
   */
  parseFavourites(text, valueOf = () => undefined) {
    const out = [];
    const sections = {};
    const stack = []; // each: { taken: this branch is live, done: an earlier branch was taken }
    const live = () => stack.every((f) => f.taken);
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const m = /^@if\s+(.+?)\s*(=|!=)\s*(.+)$/i.exec(line);
      if (m) {
        const v = String(valueOf(m[1].trim()) ?? '').trim().toLowerCase();
        const eq = v === m[3].trim().toLowerCase();
        const taken = m[2] === '=' ? eq : !eq;
        stack.push({ taken, done: taken });
        continue;
      }
      if (/^@else$/i.test(line)) { const f = stack.at(-1); if (f) { f.taken = !f.done; f.done = true; } continue; }
      if (/^@end$/i.test(line)) { stack.pop(); continue; }
      const sec = /^@section\s+(\S+)/i.exec(line);
      if (sec) { if (live()) (sections[sec[1].toLowerCase()] ??= []).push(out.length); continue; }
      if (live()) out.push(line);
    }
    // where each section starts, as an index into the names: e.g. { eq: [0], dyn: [16, 24] }
    Object.defineProperty(out, 'sections', { value: sections, enumerable: false });
    return out;
  },

  /** Parameters in favourites order first (matched by name, case ignored), then everything else. */
  orderParams(params, favourites) {
    if (!favourites?.length) return params;
    const key = (s) => String(s ?? '').trim().toLowerCase();
    const byName = new Map(params.map((p) => [key(p.name.value), p]));
    const first = [];
    for (const n of favourites) { const p = byName.get(key(n)); if (p && !first.includes(p)) first.push(p); }
    return [...first, ...params.filter((p) => !first.includes(p))];
  },
};

/**
 * One control being driven from the Push: touch handling and write coalescing.
 * Encoders send a message every 2-4 ms; LUNA gets at most one write in flight per control,
 * always the latest value.
 */
class Driven {
  constructor(control) {
    this.control = control;
    this.touched = 0;          // fingers/gestures holding the touch
    this.target = undefined;   // value waiting to be written
    this.writing = false;
    this.idle = null;
  }

  value() {
    return this.target ?? this.control.normalized.value ?? 0;
  }

  begin() {
    if (this.touched++ === 0) this.control.begin();
  }

  end() {
    if (this.touched === 0) return;
    if (--this.touched === 0) this.flush().finally(() => { if (this.touched === 0) this.control.end(); });
  }

  /** A turn with no finger on the encoder (a touch-less controller): hold a touch until it goes quiet. */
  autoTouch(ms = 400) {
    if (!this.idle) this.begin();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.end(); }, ms);
  }

  set(v) {
    this.target = AddOnLogic.clamp01(v);
    return this.flush();
  }

  async flush() {
    if (this.writing) return this.pending;
    this.writing = true;
    this.pending = (async () => {
      try {
        while (this.target !== undefined) {
          const v = this.target;
          this.target = undefined;
          await this.control.normalized.set(v);
        }
      } finally {
        this.writing = false;
      }
    })();
    return this.pending;
  }
}

/**
 * Selected faders moving together, as Logic Pro does it: move the volume of one SELECTED
 * track while several are selected, and every selected track moves by the same number of dB,
 * keeping the balance. A track at -inf stays there; one that reaches its top or bottom stops
 * while the others carry on. Each follower is touched for the whole move, so automation
 * writes on all of them.
 */
class Gang {
  /** `leader` is a Track; `members` the other selected Tracks; `drive(control)` gives each a Driven. */
  constructor(leader, members, drive) {
    const taperOf = (t) => t.gain.taper?.value ?? null;
    this.leaderTaper = taperOf(leader);
    this.leaderStart = this.toDb(this.leaderTaper, leader.gain.normalized.value ?? 0);
    this.members = members.map((t) => {
      const taper = taperOf(t);
      const norm = t.gain.normalized.value ?? 0;
      return { track: t, taper, driven: drive(t.gain), startNorm: norm, startDb: this.toDb(taper, norm) };
    });
    for (const m of this.members) m.driven.begin();
  }

  toDb(taper, n) {
    return taper?.toDb ? taper.toDb(n) : n; // without a taper, move in normalized units
  }

  /** The leader is going to `n` (normalized): move everyone else by the same dB. */
  follow(n) {
    const offset = this.toDb(this.leaderTaper, n) - this.leaderStart;
    for (const m of this.members) {
      const { taper } = m;
      if (taper?.toNormalized) {
        if (m.startDb <= taper.minDb) continue; // -inf stays at -inf
        const db = Math.min(taper.maxDb, Math.max(taper.minDb, m.startDb + offset));
        m.driven.set(taper.toNormalized(db));
      } else {
        m.driven.set(AddOnLogic.clamp01(m.startNorm + offset));
      }
    }
  }

  end() {
    for (const m of this.members) m.driven.end();
  }
}

/** A gang for `track` when it is one of several selected tracks in LUNA, else null. */
function gangFor(session, track, drive) {
  const ids = session.context?.selectionTracks?.value ?? [];
  if (!track || ids.length < 2 || !ids.includes(track.id)) return null;
  const members = ids.filter((id) => id !== track.id).map((id) => session.tracks.byId(id)).filter((t) => t?.gain);
  return members.length ? new Gang(track, members, drive) : null;
}

/**
 * The surface: eight encoders over a bank of eight tracks, a knobset (FADER, PAN), and the
 * touch strip as the fader of the selected track.
 */
class Surface {
  constructor(session, { onChange = () => {} } = {}) {
    this.session = session;
    this.onChange = onChange;
    this.mode = 'fader';
    this.bankStart = 0;
    this.shift = false;
    this.driven = new Map(); // control -> Driven
    this.touchedStrips = new Set();
    this.stripDriven = null;
    this.plug = null;          // { channel, effect } the PLUG knobset drives
    this.plugPage = 0;
    this.favOn = true;
    this.favourites = {};      // plugin name -> [parameter names], filled by loadFavourites
    this.loadFavourites = async () => null; // set by the page: fetches favourites/<plugin>.txt
    this.lastMode = 'pan';
    this.slots = [];           // the selected track's insert slots: { effect, empty, name }
    this.accum = new Map();    // stepped control -> detents not yet spent
    this.gangs = new Map();    // leader gain control -> Gang (selected faders moving together)
    this.stripGang = null;
    // Pinned tracks (PushDesk's LAYOUTS, set from the Push): column -> { id, name }. A pinned
    // track stays on its strip while the other strips bank around it. Saved with the session.
    this.pins = new Map();
    this.pinsOn = true;        // Layout tapped: all tracks, the pins kept for later
    this.otherBankStart = 0;   // the bank position of the other view (pins on / off)
    this.layoutHeld = false;
    this.layoutUsed = false;   // a pad was pressed while Layout was held, so its release is no tap
    this.onPinsChange = () => {}; // set by the page: save the pins
  }

  tracks() {
    return this.session.visibleTracks;
  }

  /** The pins in use: column -> { id, name }, none while they're switched off. */
  activePins() {
    return this.pinsOn ? this.pins : new Map();
  }

  /** The tracks the free strips bank through: every track that isn't pinned. */
  freeTracks() {
    const pins = this.activePins();
    if (!pins.size) return this.tracks();
    const pinned = new Set([...pins.values()].map((p) => p.id));
    return this.tracks().filter((t) => !pinned.has(t.id));
  }

  /** How many strips bank: 8 less the pins. */
  bankWidth() {
    return 8 - this.activePins().size;
  }

  /**
   * The tracks under the encoders, by column. With no pins: the bank, shorter at the end of the
   * session. With pins: always 8 entries, a pinned track in its own column (null when it has
   * been deleted: the strip stays empty, so nothing shifts) and the free tracks in the others.
   */
  bank() {
    const pins = this.activePins();
    const free = this.freeTracks();
    const w = 8 - pins.size;
    if (w > 0 && this.bankStart >= free.length) this.bankStart = Math.max(0, Math.floor((free.length - 1) / w) * w);
    if (!pins.size) return free.slice(this.bankStart, this.bankStart + 8);
    const all = this.tracks();
    let k = this.bankStart;
    return Array.from({ length: 8 }, (_, col) => {
      const pin = pins.get(col);
      return pin ? all.find((t) => t.id === pin.id) ?? null : free[k++] ?? null;
    });
  }

  /**
   * Layout held + a select pad: pin the track that column shows, or unpin it if it's pinned
   * there. Pinning leaves every strip where it was. Unpinning keeps that track on its strip,
   * with its own neighbours banking around it. With the pins switched off, a pin switches them
   * back on.
   */
  togglePin(col) {
    if (col < 0 || col > 7) return;
    const shown = this.bank()[col];
    const pin = this.activePins().get(col);
    if (!shown && !pin) return;
    this.releaseAll();
    if (pin) {
      this.pins.delete(col);
      const free = this.freeTracks();
      const i = shown ? free.indexOf(shown) : -1;
      if (i >= 0) {
        const freeCol = Array.from({ length: col }, (_, c) => c).filter((c) => !this.pins.has(c)).length;
        this.bankStart = Math.max(0, i - freeCol);
      }
    } else {
      if (!this.pinsOn) { this.pinsOn = true; [this.bankStart, this.otherBankStart] = [this.otherBankStart, this.bankStart]; }
      for (const [c, p] of this.pins) if (p.id === shown.id) this.pins.delete(c);
      this.pins.set(col, { id: shown.id, name: shown.name.value ?? '' });
    }
    this.notice = null;
    this.onPinsChange();
    this.onChange();
  }

  /** Layout tapped: all tracks <-> the pins, each view keeping its own bank position. */
  togglePins() {
    if (!this.pins.size) {
      this.notice = 'To pin a track to its strip: hold Layout and press its select pad';
      this.onChange();
      return;
    }
    this.releaseAll();
    this.pinsOn = !this.pinsOn;
    [this.bankStart, this.otherBankStart] = [this.otherBankStart, this.bankStart];
    this.notice = null;
    this.onPinsChange();
    this.onChange();
  }

  /** The pins as saved with the session. */
  pinsData() {
    return { on: this.pinsOn, pins: [...this.pins].map(([col, p]) => ({ col, id: p.id, name: p.name })) };
  }

  /** Put back pins saved with the session (anything malformed is skipped). */
  setPins(data) {
    this.pins = new Map();
    for (const p of Array.isArray(data?.pins) ? data.pins : []) {
      if (Number.isInteger(p?.col) && p.col >= 0 && p.col < 8 && typeof p.id === 'string' && p.id) this.pins.set(p.col, { id: p.id, name: String(p.name ?? '') });
    }
    this.pinsOn = data?.on !== false;
    this.bankStart = 0;
    this.otherBankStart = 0;
    this.releaseAll();
    this.onChange();
  }

  controlFor(track, mode = this.mode) {
    return mode === 'pan' ? track.pan : track.gain;
  }

  /** The current plugin's parameters, favourites first when they're on. */
  plugParams() {
    const e = this.plug?.effect;
    if (!e || e.isEmpty) return [];
    const params = e.params ?? [];
    const raw = this.favOn ? this.favourites[e.pluginName.value] : null;
    // a favourites file (text, which may follow the plugin's own switches) or a plain list
    const valueOf = (n) => params.find((p) => String(p.name.value).toLowerCase() === n.toLowerCase())?.display.value;
    const fav = typeof raw === 'string' ? AddOnLogic.parseFavourites(raw, valueOf) : raw;
    if (!fav?.length) { const plain = [...params]; Object.defineProperty(plain, 'sectionPages', { value: {}, enumerable: false }); return plain; }
    // Favourites first, then everything else. Each @section starts a fresh Push page (empty
    // slots fill the rest of the page before it), so EQ / DYN always land on a whole page.
    const key = (x) => String(x ?? '').trim().toLowerCase();
    const byName = new Map(params.map((p) => [key(p.name.value), p]));
    const startsAt = new Map(); // favourites index -> section names starting there
    for (const [k, list] of Object.entries(fav.sections ?? {})) for (const i of list) startsAt.set(i, [...(startsAt.get(i) ?? []), k]);
    const ordered = [];
    const used = new Set();
    const sectionPages = {};
    const section = (i) => {
      const ks = startsAt.get(i);
      if (!ks) return;
      while (ordered.length % 8) ordered.push(null);
      for (const k of ks) (sectionPages[k] ??= []).push(ordered.length / 8);
    };
    fav.forEach((n, i) => {
      section(i);
      const p = byName.get(key(n));
      if (p && !used.has(p)) { ordered.push(p); used.add(p); }
    });
    section(fav.length); // a section marker at the very end
    // the rest follows straight on, as PushDesk's favPluginApply does (only @section starts a page)
    for (const p of params) if (!used.has(p)) ordered.push(p);
    Object.defineProperty(ordered, 'sectionPages', { value: sectionPages, enumerable: false });
    return ordered;
  }

  /**
   * EQ / DYN buttons: the selected track's channel strip (its console extension, e.g. API
   * Vision), at the page where that section starts. DYN again moves to the next DYN section
   * (compressor, then gate).
   */
  async gotoSection(section, track = this.session.focusedTrack.value) {
    if (!track) return;
    try { await track.effects.load(); } catch { /* none */ }
    const strip = track.effects?.byId?.('console');
    const effect = strip && !strip.isEmpty ? strip : (this.plug?.channel === track ? this.plug.effect : null);
    if (!effect) {
      this.releaseAll();
      this.mode = section;
      this.plug = { channel: track, effect: null, index: -1 };
      this.notice = `No channel strip on “${track.name.value}”`;
      this.onChange();
      return;
    }
    const again = this.mode === section && this.plug?.effect === effect;
    if (this.plug?.effect !== effect) await this.setPlug(track, effect, { switchMode: false });
    if (!this.favOn) { this.favOn = true; }
    const pages = this.plugParams().sectionPages?.[section] ?? [];
    let page = pages[0] ?? 0;
    if (again && pages.length > 1) page = pages[(pages.indexOf(this.plugPage) + 1) % pages.length];
    this.releaseAll();
    if (this.mode !== 'fader' && this.mode !== section) this.lastMode = this.mode;
    this.mode = section;
    this.plugPage = page;
    this.notice = pages.length ? null : `${effect.pluginName.value} has no ${section.toUpperCase()} section in its favourites`;
    this.onChange();
  }

  /** What encoder i drives now, or null. */
  targetFor(i) {
    if (PLUG_MODES.includes(this.mode)) return this.plugParams()[this.plugPage * 8 + i] ?? null;
    const track = this.bank()[i];
    return track ? this.controlFor(track) : null;
  }

  hasFavourites() {
    const e = this.plug?.effect;
    const f = e && this.favourites[e.pluginName.value];
    return !!(typeof f === 'string' ? f.trim() : f?.length);
  }

  drive(control) {
    let d = this.driven.get(control);
    if (!d) { d = new Driven(control); this.driven.set(control, d); }
    return d;
  }

  /** What the display shows: one entry per encoder. */
  strips() {
    if (PLUG_MODES.includes(this.mode)) {
      const params = this.plugParams();
      return Array.from({ length: 8 }, (_, i) => {
        const p = params[this.plugPage * 8 + i];
        if (!p) return { index: i, empty: true };
        return { index: i, id: p.uid?.value ?? `${i}`, name: p.name.value ?? '', value: p.normalized.value ?? 0, display: p.display.value ?? '', touched: this.touchedStrips.has(i), param: true };
      });
    }
    const bank = this.bank();
    const pins = this.activePins();
    return Array.from({ length: 8 }, (_, i) => {
      const track = bank[i];
      const pin = pins.get(i);
      if (!track) return pin ? { index: i, empty: true, pinned: true, missing: pin.name } : { index: i, empty: true };
      const c = this.controlFor(track);
      return {
        index: i,
        id: track.id,
        name: track.name.value ?? '',
        color: track.color.value,
        value: c?.normalized.value ?? 0,
        display: c?.display.value ?? '',
        touched: this.touchedStrips.has(i),
        selected: this.session.focusedTrack.value === track,
        pinned: !!pin,
      };
    });
  }

  setMode(mode) {
    if (!mode || !MODES.includes(mode) || mode === this.mode) return;
    this.releaseAll();
    if (this.mode !== 'fader') this.lastMode = this.mode;
    this.mode = mode;
    this.onChange();
  }

  page(dir) {
    if (PLUG_MODES.includes(this.mode)) {
      const pages = Math.ceil(this.plugParams().length / 8);
      const next = this.plugPage + dir;
      if (next < 0 || next >= pages) return;
      this.releaseAll();
      this.plugPage = next;
      this.onChange();
      return;
    }
    // Tracks page by the free strips' width (8, or 8 less the pins).
    const w = this.bankWidth();
    const n = this.freeTracks().length;
    const next = dir < 0 ? Math.max(0, this.bankStart - w) : this.bankStart + w;
    if (w <= 0 || next === this.bankStart || next >= n) return;
    this.releaseAll();
    this.bankStart = next;
    this.onChange();
  }

  /**
   * LUNA's selection moved: if the selected track is not on show, page the free strips to it,
   * keeping the bank's alignment (PushDesk's bankTo). A pinned track is always on show. Called
   * only when the selection CHANGES, so a bank you paged to by hand is never undone (PUSH
   * CLAUDE.md, 2026-10-05).
   */
  followSelection(track = this.session.focusedTrack.value) {
    const free = this.freeTracks();
    const w = this.bankWidth();
    const i = track ? free.indexOf(track) : -1;
    if (w <= 0 || i < 0 || (i >= this.bankStart && i < this.bankStart + w)) return false;
    const offset = this.bankStart % w;
    this.releaseAll();
    this.bankStart = Math.max(0, offset + Math.floor((i - offset) / w) * w);
    this.onChange();
    return true;
  }

  /** Let go of every touch we hold (bank or mode change, disconnect). */
  releaseAll() {
    for (const g of this.gangs.values()) g.end();
    this.gangs.clear();
    if (this.stripGang) { this.stripGang.end(); this.stripGang = null; }
    for (const d of this.driven.values()) {
      clearTimeout(d.idle); d.idle = null;
      while (d.touched > 0) d.end();
    }
    this.touchedStrips.clear();
  }

  encoderTouch(i, on) {
    const c = this.targetFor(i);
    if (!c) return;
    const d = this.drive(c);
    const track = this.mode === 'fader' ? this.bank()[i] : null;
    if (on) {
      this.touchedStrips.add(i);
      d.begin();
      const g = track && !this.gangs.has(c) ? gangFor(this.session, track, (x) => this.drive(x)) : null;
      if (g) this.gangs.set(c, g);
    } else {
      this.touchedStrips.delete(i);
      d.end();
      const g = this.gangs.get(c);
      if (g) { g.end(); this.gangs.delete(c); }
    }
    this.onChange();
  }

  encoderTurn(i, raw) {
    const c = this.targetFor(i);
    if (!c) return;
    const d = this.drive(c);
    if (!this.touchedStrips.has(i)) d.autoTouch();
    const delta = AddOnLogic.delta(raw);
    const steps = c.numSteps?.value ?? 0;
    if (PLUG_MODES.includes(this.mode) && c.discrete?.value && steps >= 2 && steps <= 64) {
      // A stepped control: spend several detents per position, or a switch skips (PushDesk notes/04).
      const need = this.shift ? 8 : 4;
      const acc = (this.accum.get(c) ?? 0) + delta;
      const move = Math.trunc(acc / need);
      this.accum.set(c, acc - move * need);
      if (!move) return;
      return d.set(d.value() + move / (steps - 1));
    }
    const v = AddOnLogic.clamp01(d.value() + delta * AddOnLogic.step(PLUG_MODES.includes(this.mode) ? 'param' : this.mode, this.shift));
    this.gangs.get(c)?.follow(v);
    return d.set(v);
  }

  /** Make `effect` on `channel` the plugin the PLUG knobset drives, and switch to PLUG. */
  async setPlug(channel, effect, { switchMode = true } = {}) {
    if (!effect || effect.isEmpty) return;
    try { await effect.controls.load(); } catch { /* params may arrive later */ }
    const name = effect.pluginName.value;
    if (name && !(name in this.favourites)) {
      try { this.favourites[name] = await this.loadFavourites(name); } catch { this.favourites[name] = null; }
    }
    this.releaseAll();
    this.plug = { channel, effect, index: AddOnLogic.orderedPlugins(channel).indexOf(effect) };
    this.plugPage = 0;
    if (switchMode) this.setMode('plug');
    this.onChange();
  }

  /**
   * Re-read the selected track's plugins for the lower row: the loaded ones in LUNA's mixer
   * order (the console extension, e.g. API Vision, then the tape extension, then inserts 1-8),
   * up to eight. The console and tape slots are not among `effectSlots`, so they're asked for
   * by id.
   */
  async refreshSlots(track = this.session.focusedTrack.value) {
    if (!track) { this.slots = []; this.onChange(); return; }
    try { await track.effects.load(); } catch { /* none */ }
    if (track !== this.session.focusedTrack.value) return;
    this.slots = AddOnLogic.orderedPlugins(track).slice(0, 8).map((e) => ({ effect: e, empty: false, name: e.pluginName?.value ?? '' }));
    this.onChange();
  }

  /** Lower row button k: drive the k-th plugin of the selected track, and open its window. */
  async selectSlot(k) {
    const track = this.session.focusedTrack.value;
    if (!track) return;
    if (!this.slots.length) await this.refreshSlots(track);
    const slot = this.slots[k]?.effect;
    if (!slot || slot.isEmpty) { this.notice = `No plugin under button ${k + 1} on “${track.name.value}”`; this.onChange(); return; }
    if (slot.loaded?.value === false) { this.notice = `${slot.pluginName.value} on “${track.name.value}” isn't loaded in LUNA`; this.onChange(); return; }
    this.notice = null;
    await this.setPlug(track, slot);
    if (!AddOnLogic.isExtension(slot)) {
      try { await slot.openEditor(); } catch { /* window stays shut: still controllable */ }
    }
  }

  /** A plugin window opened in LUNA: the encoders follow it, as Push does in Live. */
  /**
   * LUNA's selection moved while in PLUG: take the plugin control to the new track. The same
   * plugin if it has one (keeping the page, so you can step through tracks on the same EQ
   * page), else the plugin in the same place in the row, else its first plugin.
   */
  async followPlugin(track = this.session.focusedTrack.value) {
    if (!PLUG_MODES.includes(this.mode) || !this.plug || !track || this.plug.channel === track) return;
    if (this.mode === 'eq' || this.mode === 'dyn') {
      // keep the same section (and which DYN page) on the new track's channel strip
      const pages = this.plugParams().sectionPages?.[this.mode] ?? [];
      const which = Math.max(0, pages.indexOf(this.plugPage));
      const mode = this.mode;
      this.mode = 'plug'; // so gotoSection doesn't treat it as a second press
      await this.gotoSection(mode, track);
      const now = this.plugParams().sectionPages?.[mode] ?? [];
      if (now[which] !== undefined) { this.plugPage = now[which]; this.onChange(); }
      return;
    }
    try { await track.effects.load(); } catch { /* none */ }
    if (track !== this.session.focusedTrack.value) return; // the selection moved on again
    const list = AddOnLogic.orderedPlugins(track);
    const prev = this.plug;
    const prevName = prev.effect?.pluginName?.value;
    const same = list.find((e) => e.pluginName?.value === prevName);
    const pick = same ?? list[prev.index] ?? list[0];
    if (!pick) {
      this.releaseAll();
      this.plug = { channel: track, effect: null, index: -1 };
      this.notice = `No plugins on “${track.name.value}”`;
      this.onChange();
      return;
    }
    const page = same ? this.plugPage : 0;
    this.notice = null;
    await this.setPlug(track, pick, { switchMode: false });
    const pages = Math.max(1, Math.ceil(this.plugParams().length / 8));
    this.plugPage = Math.min(page, pages - 1);
    this.onChange();
  }

  async focusPlugin(channelUid, slotId) {
    const channel = this.session.channelsInOrder.find((c) => c.id === channelUid);
    if (!channel) return;
    try { await channel.effects.load(); } catch { return; }
    let effect = channel.effects.byId(slotId);
    // A window opened from LUNA's insert shortcut (`alias.console` / `alias.tape`): follow the extension itself.
    const alias = /^alias\.(console|tape)$/.exec(String(effect?.pluginId?.value ?? ''));
    if (alias) effect = channel.effects.byId(alias[1]);
    if (effect && !effect.isEmpty && effect !== this.plug?.effect) await this.setPlug(channel, effect);
  }

  toggleFavourites() {
    this.favOn = !this.favOn;
    this.plugPage = 0;
    this.releaseAll();
    this.onChange();
  }

  stripTouch(on) {
    const track = this.session.focusedTrack.value;
    if (on) {
      if (!track) return;
      this.stripDriven = this.drive(track.gain);
      this.stripDriven.begin();
      this.stripGang = gangFor(this.session, track, (x) => this.drive(x));
    } else if (this.stripDriven) {
      this.stripDriven.end();
      this.stripDriven = null;
      this.stripGang?.end();
      this.stripGang = null;
    }
  }

  stripMove(position) {
    const d = this.stripDriven;
    if (!d) return; // only while a finger is on the strip: never write without a touch
    this.stripGang?.follow(position);
    return d.set(position);
  }

  /** A pad pressed: the bottom four rows act on the eight tracks under the encoders. */
  async padPress(note) {
    const n = note - PUSH.PAD_BASE, row = Math.floor(n / 8), col = n % 8;
    const what = PAD_ROWS[row];
    if (what === 'select' && this.layoutHeld) { this.layoutUsed = true; this.togglePin(col); return; }
    const track = this.bank()[col];
    if (!what || !track) return;
    if (what === 'select') {
      const ctx = this.session.context;
      await ctx.selectionTracks.set([track.id]);
      await ctx.lastSelectedTrack.set(track.id);
    } else if (what === 'mute') await track.mute.toggle();
    else if (what === 'solo') await track.solo.toggle();
    else if (what === 'rec') {
      const want = !track.recordEnabled.value;
      await track.recordEnabled.set(want);
      // LUNA answers success even when it refuses to arm (e.g. an input it can't record from),
      // so check, and say so on the panel.
      await new Promise((r) => setTimeout(r, 400));
      this.notice = track.recordEnabled.value === want ? null : `LUNA couldn't ${want ? 'arm' : 'disarm'} “${track.name.value}” — check its input in LUNA`;
    }
    this.onChange();
  }

  /** PLUG pressed with no plugin chosen yet: the selected track's first plugin. */
  async selectFirstPlugin() {
    if (!this.slots.length) await this.refreshSlots();
    const k = this.slots.findIndex((s) => !s.empty);
    if (k >= 0) await this.selectSlot(k);
    else { this.notice = 'No plugins on the selected track'; this.onChange(); }
  }

  /** One message from Luna.MidiInput. Returns true when it was ours. */
  handleMidi(m) {
    if (m.channel !== 0 && m.channel !== undefined) return false;
    const { type, data1: d1, data2: d2 } = m;
    if (type === 'controlChange') {
      if (d1 >= PUSH.ENCODER_CC && d1 < PUSH.ENCODER_CC + 8) { this.encoderTurn(d1 - PUSH.ENCODER_CC, d2); return true; }
      if (d1 === PUSH.SHIFT_CC) { const was = this.shift; this.shift = d2 > 0; if (was !== this.shift) this.onChange(); return true; }
      if (d1 === PUSH.LAYOUT_CC) { // a modifier while held; a tap with no pad pressed meanwhile = pins off/on
        if (d2 > 0) { this.layoutHeld = true; this.layoutUsed = false; this.onChange(); }
        else if (this.layoutHeld) { this.layoutHeld = false; if (!this.layoutUsed) this.togglePins(); else this.onChange(); }
        return true;
      }
      const ours = (d1 >= PUSH.KNOBSET_CC && d1 < PUSH.KNOBSET_CC + 8) || (d1 >= PUSH.LOWER_ROW_CC && d1 < PUSH.LOWER_ROW_CC + 8)
        || [PUSH.PAGE_PREV_CC, PUSH.PAGE_NEXT_CC, PUSH.FAVOURITES_CC, PUSH.LAST_KNOBSET_CC].includes(d1);
      if (d2 === 0) return ours; // releases
      if (d1 >= PUSH.KNOBSET_CC && d1 < PUSH.KNOBSET_CC + 8) { const m = MODES[d1 - PUSH.KNOBSET_CC]; if (m === 'eq' || m === 'dyn') this.gotoSection(m); else if (m === 'plug' && !this.plug?.effect) this.selectFirstPlugin(); else this.setMode(m); return true; }
      if (d1 >= PUSH.LOWER_ROW_CC && d1 < PUSH.LOWER_ROW_CC + 8) { this.selectSlot(d1 - PUSH.LOWER_ROW_CC); return true; }
      if (d1 === PUSH.FAVOURITES_CC) { if (PLUG_MODES.includes(this.mode)) this.toggleFavourites(); return true; }
      if (d1 === PUSH.LAST_KNOBSET_CC) { this.setMode(this.mode === 'fader' ? this.lastMode : 'fader'); return true; }
      if (d1 === PUSH.PAGE_PREV_CC) { this.page(-1); return true; }
      if (d1 === PUSH.PAGE_NEXT_CC) { this.page(1); return true; }
      return false;
    }
    if (type === 'noteOn' || type === 'noteOff') {
      const on = type === 'noteOn' && d2 > 0;
      if (d1 >= PUSH.ENCODER_TOUCH_NOTE && d1 < PUSH.ENCODER_TOUCH_NOTE + 8) { this.encoderTouch(d1 - PUSH.ENCODER_TOUCH_NOTE, on); return true; }
      if (d1 === PUSH.STRIP_TOUCH_NOTE) { this.stripTouch(on); return true; }
      if (d1 >= PUSH.PAD_BASE && d1 < PUSH.PAD_BASE + 64) { if (on) this.padPress(d1); return true; }
      return false;
    }
    if (type === 'polyAftertouch' || type === 'polyPressure' || type === 'keyPressure' || type === 'channelPressure') return true; // pad pressure: not used
    if (type === 'pitchBend') {
      if (!AddOnLogic.isLiftOff(d1, d2)) this.stripMove(AddOnLogic.stripPosition(d1, d2)); // else: the finger lifting, not a move
      return true;
    }
    return false;
  }
}

/**
 * Pete's DIY motor fader ("PushDesk Fader", PUSH docs/notes/15): Mackie single-fader MIDI,
 * pitch bend ch1 = 14-bit position both ways, note 104 = touch, buttons on notes.
 * It follows LUNA's selected track (or a locked one) with Avid's mechanics:
 *   touch: start LUNA's touch, then take the fader's position;
 *   while touched: LUNA does not drive the motor, and positions only count while touched;
 *   release: end the touch, THEN snap the motor to LUNA's value;
 *   a new track is followed after a 200 ms settle; motor updates are paced to one per 50 ms.
 */
const FADER = {
  PORT: 'PushDesk Fader',
  TOUCH_NOTE: 104,
  SOLO_NOTE: 8,
  MUTE_NOTE: 16,
  UTILITY_NOTE: 54, // motors off / on
  LOCK_CC: 118,     // the Push's Delete button: lock the fader to this track / follow again
  SETTLE_MS: 200,
  PACE_MS: 50,
};

class MotorFader {
  /** `send(status, data1, data2)` writes to the fader's MIDI output. */
  constructor(session, send, { onChange = () => {}, timers = globalThis } = {}) {
    this.session = session;
    this.send = send;
    this.onChange = onChange;
    this.timers = timers;
    this.locked = null;      // a Track pinned with Delete, or null to follow the selection
    this.track = null;       // the track the fader drives now
    this.touched = false;
    this.motorsOn = true;
    this.driven = null;
    this.unwatch = null;
    this.lastSent = undefined;
    this.paceTimer = null;
    this.settleTimer = null;
  }

  /** The track the fader should drive: the locked one, else LUNA's selected track. */
  wanted() {
    return this.locked ?? this.session.focusedTrack.value ?? null;
  }

  /** Re-target after a selection change, after Avid's 200 ms settle. */
  follow({ now = false } = {}) {
    this.timers.clearTimeout(this.settleTimer);
    const go = () => this.attach(this.wanted());
    if (now) go(); else this.settleTimer = this.timers.setTimeout(go, FADER.SETTLE_MS);
  }

  async attach(track) {
    if (track === this.track) return;
    if (this.touched) return; // never swap tracks under a finger; release re-follows
    this.unwatch?.();
    this.unwatch = null;
    this.track = track;
    this.driven = null;
    this.onChange();
    if (!track) return;
    try { await track.loadStrip(); } catch { /* strip not loaded: no gain to follow */ }
    if (this.track !== track) return;
    this.unwatch = track.gain.normalized.onChange(() => this.queueMotor());
    this.queueMotor({ now: true });
  }

  value() {
    return this.track?.gain.normalized.value;
  }

  /** Move the motor to LUNA's value, at most once per 50 ms, never while touched or with motors off. */
  queueMotor({ now = false } = {}) {
    if (this.touched || !this.motorsOn) return;
    if (now) { this.timers.clearTimeout(this.paceTimer); this.paceTimer = null; this.sendMotor(); return; }
    if (this.paceTimer) return;
    this.paceTimer = this.timers.setTimeout(() => { this.paceTimer = null; this.sendMotor(); }, FADER.PACE_MS);
  }

  sendMotor() {
    const v = this.value();
    if (v === undefined || this.touched || !this.motorsOn) return;
    const pos = Math.round(AddOnLogic.clamp01(v) * 16383);
    if (pos === this.lastSent) return;
    this.lastSent = pos;
    this.send(0xe0, pos & 0x7f, (pos >> 7) & 0x7f);
  }

  touch(on) {
    if (on) {
      if (this.touched || !this.track) return;
      this.touched = true;
      this.timers.clearTimeout(this.paceTimer); this.paceTimer = null;
      this.driven = new Driven(this.track.gain);
      this.driven.begin();
      this.gang = gangFor(this.session, this.track, (c) => new Driven(c));
    } else {
      if (!this.touched) return;
      this.touched = false;
      const d = this.driven;
      this.driven = null;
      this.gang?.end();
      this.gang = null;
      // End the touch, THEN snap the motor to LUNA's value (Avid's order).
      Promise.resolve(d?.flush()).finally(() => {
        d?.end();
        this.lastSent = undefined;
        this.queueMotor({ now: true });
        if (this.wanted() !== this.track) this.follow({ now: true });
      });
    }
    this.onChange();
  }

  move(position) {
    if (!this.touched || !this.driven) return; // positions only count while touched
    this.gang?.follow(position);
    return this.driven.set(position);
  }

  toggleLock() {
    this.locked = this.locked ? null : this.track;
    this.follow({ now: true });
    this.onChange();
  }

  /** The track list changed: a locked track that has been deleted lets go (as PushDesk does). */
  checkLock() {
    if (!this.locked || this.session.tracks.byId(this.locked.id)) return;
    this.locked = null;
    this.follow({ now: true });
    this.onChange();
  }

  setMotors(on) {
    this.motorsOn = on;
    if (on) { this.lastSent = undefined; this.queueMotor({ now: true }); }
    this.onChange();
  }

  async press(note) {
    const track = this.track;
    if (note === FADER.UTILITY_NOTE) return this.setMotors(!this.motorsOn);
    if (!track) return;
    if (note === FADER.SOLO_NOTE) await track.solo?.toggle();
    if (note === FADER.MUTE_NOTE) await track.mute?.toggle();
  }

  /** A message from the fader's MIDI input. Returns true when it was ours. */
  handleMidi(m) {
    if (m.channel !== 0 && m.channel !== undefined) return false;
    const { type, data1: d1, data2: d2 } = m;
    if (type === 'pitchBend') { this.move(AddOnLogic.stripPosition(d1, d2)); return true; }
    if (type === 'noteOn' || type === 'noteOff') {
      const on = type === 'noteOn' && d2 > 0;
      if (d1 === FADER.TOUCH_NOTE) { this.touch(on); return true; }
      if (on && [FADER.SOLO_NOTE, FADER.MUTE_NOTE, FADER.UTILITY_NOTE].includes(d1)) { this.press(d1); return true; }
      return [FADER.SOLO_NOTE, FADER.MUTE_NOTE, FADER.UTILITY_NOTE].includes(d1);
    }
    return false;
  }

  /** Let go of everything (page hidden, LUNA disconnected). */
  release() {
    if (this.touched) this.touch(false);
    this.timers.clearTimeout(this.paceTimer);
    this.timers.clearTimeout(this.settleTimer);
    this.unwatch?.();
    this.unwatch = null;
  }
}

/**
 * Button lights, as PushDesk does them (PUSH src/pushdesk.cpp, setupPadPalette and
 * updateButtonLeds): our own palette entries written over SysEx, then one CC per button whose
 * value is the palette entry. White buttons take their brightness from the W channel, so they
 * need an entry with W set (kColWhiteDim) or they stay dark.
 */
const LED = {
  SEL: 102,        // bright: (200, 200, 200, W 90)
  SEL_DIM: 107,    // dim, for the coloured knobset buttons: (20, 20, 24, W 0)
  WHITE_DIM: 118,  // dim, for white buttons (Shift, Delete, arrows): (20, 20, 24, W 20)
  MUTE: 103, MUTE_DIM: 108, SOLO: 105, SOLO_DIM: 109, REC: 106, REC_DIM: 110,
  PIN: 111, PIN_DIM: 112, // the select row while Layout is held: pinned strips bright
  PALETTE: [
    [102, 200, 200, 200, 90], [107, 20, 20, 24, 0], [118, 20, 20, 24, 20],
    [103, 255, 100, 0, 0], [108, 18, 7, 0, 0],   // mute: orange
    [105, 255, 200, 0, 0], [109, 18, 13, 0, 0],  // solo: yellow
    [106, 255, 0, 0, 0], [110, 18, 0, 0, 0],     // record: red
    [111, 0, 140, 255, 0], [112, 0, 9, 18, 0],   // pins: blue
  ],
};

/** The SysEx messages that write our palette entries, then the one that applies them. */
function paletteSysEx() {
  const lo = (v) => v & 0x7f, hi = (v) => (v >> 7) & 0x7f;
  const set = LED.PALETTE.map(([i, r, g, b, w]) => [0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x03, i, lo(r), hi(r), lo(g), hi(g), lo(b), hi(b), lo(w), hi(w), 0xf7]);
  return [...set, [0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x05, 0xf7]];
}

/** What each lit button should show now: { cc: paletteEntry } (0 = dark). */
function buttonLeds(surface, fader, { off = false } = {}) {
  const out = {};
  for (let k = 0; k < 8; k++) {
    const mode = MODES[k];
    out[PUSH.KNOBSET_CC + k] = off || !mode ? 0 : surface?.mode === mode ? LED.SEL : LED.SEL_DIM;
  }
  const n = surface?.freeTracks().length ?? 0;
  const w = surface?.bankWidth() ?? 8;
  out[PUSH.PAGE_PREV_CC] = !off && surface && w > 0 && surface.bankStart > 0 ? LED.WHITE_DIM : 0;
  out[PUSH.PAGE_NEXT_CC] = !off && surface && w > 0 && surface.bankStart + w < n ? LED.WHITE_DIM : 0;
  out[PUSH.SHIFT_CC] = off ? 0 : surface?.shift ? LED.SEL : LED.WHITE_DIM;
  out[PUSH.LAYOUT_CC] = off || !surface ? 0 : surface.layoutHeld || surface.activePins().size ? LED.SEL : LED.WHITE_DIM;
  out[FADER.LOCK_CC] = off || !fader ? 0 : fader.locked ? LED.SEL : LED.WHITE_DIM;
  // Lower row: the selected track's inserts, dim when there's a plugin, bright for the one in PLUG.
  for (let k = 0; k < 8; k++) {
    const slot = surface?.slots?.[k];
    out[PUSH.LOWER_ROW_CC + k] = off || !slot || slot.empty ? 0 : surface.plug?.effect === slot.effect ? LED.SEL : LED.SEL_DIM;
  }
  out[PUSH.FAVOURITES_CC] = !off && PLUG_MODES.includes(surface?.mode) && surface.hasFavourites() ? (surface.favOn ? LED.SEL : LED.WHITE_DIM) : 0;
  out[PUSH.LAST_KNOBSET_CC] = off ? 0 : LED.WHITE_DIM;
  return out;
}

/**
 * Pad lights: { note: value }, value | 0x100 meaning blink. Bottom four rows: select, mute,
 * solo, record arm for the bank, dim when off and bright when on (PushDesk's colours);
 * the rest dark.
 */
function padLeds(surface, { off = false } = {}) {
  const out = {};
  const bank = off || !surface ? [] : surface.bank();
  const focused = surface?.session.focusedTrack.value;
  const pins = off || !surface ? new Map() : surface.activePins();
  const pinning = !off && !!surface?.layoutHeld; // Layout held: the select row shows the pins
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const t = bank[col];
      let v = 0;
      if (row === 0 && pinning) v = pins.has(col) ? LED.PIN : t ? LED.PIN_DIM : 0;
      else if (t && row === 0) v = t === focused ? LED.SEL : LED.SEL_DIM;
      if (t && row === 1) v = t.mute?.on ? LED.MUTE : LED.MUTE_DIM;
      if (t && row === 2) v = t.solo?.on ? LED.SOLO : LED.SOLO_DIM;
      if (t && row === 3) v = t.recordEnabled?.value ? LED.REC | 0x100 : LED.REC_DIM;
      out[PUSH.PAD_BASE + row * 8 + col] = v;
    }
  }
  return out;
}

/**
 * Sends lights only when they change, and everything again every 20th update (another app may
 * have written over them). `send(bytes)` gets [status, data1, data2]: buttons are CCs, pads are
 * notes on channel 1 (solid) or channel 15 (blink), as PushDesk sends them.
 */
class Leds {
  constructor(send) {
    this.send = send;
    this.sent = {};
    this.calls = 0;
  }

  update(buttons = {}, pads = {}) {
    if (++this.calls % 20 === 0) this.sent = {};
    for (const [cc, v] of Object.entries(buttons)) {
      const key = `c${cc}`;
      if (this.sent[key] === v) continue;
      this.send([0xb0, Number(cc), v]);
      this.sent[key] = v;
    }
    for (const [note, v] of Object.entries(pads)) {
      const key = `n${note}`;
      if (this.sent[key] === v) continue;
      this.send([v & 0x100 ? 0x9e : 0x90, Number(note), v & 0x7f]);
      this.sent[key] = v;
    }
  }
}

/**
 * What the Push screen should show, in PushDesk's state-file format, so PushDesk's own
 * pushdesk_display.py can draw it unchanged (PUSH src/pushdesk_display.py: render_tracks,
 * render_knobset, _button_row, the "mfader" chips). Returns { state, meters }:
 * meters = { m: [per bank strip], sel: the selected track } with entries
 * [legs, levelL dB, levelR dB, peakL dB, peakR dB, clip].
 */
function displayState(surface, fader) {
  const session = surface.session;
  const focused = session.focusedTrack.value;
  const hex = (c) => (typeof c === 'number' && c >= 0 ? `#${(c & 0xffffff).toString(16).padStart(6, '0')}` : '');
  const top = MODES.map((m) => (m ? MODE_LABEL[m] : ''));
  const slots = surface.slots ?? [];
  const state = {
    host: 'LUNA',
    mode: surface.mode === 'fader' ? 'FADER' : MODE_LABEL[surface.mode],
    selectedName: focused?.name.value ?? '',
    fine: !!surface.shift,
    bank: surface.bankStart + 1,
    bankWidth: 8,
    buttons: {
      top, topOn: MODES.map((m) => !!m && surface.mode === m),
      bottom: Array.from({ length: 8 }, (_, k) => (slots[k] && !slots[k].empty ? slots[k].name || `Insert ${k + 1}` : '')),
      bottomOn: Array.from({ length: 8 }, (_, k) => (!slots[k] || slots[k].empty ? -1 : surface.plug?.effect === slots[k].effect ? 1 : 0)),
    },
    mfader: fader ? { on: true, lock: fader.locked ? (fader.locked.name.value ?? 'locked') : '', motorsOff: !fader.motorsOn } : null,
  };
  const all = surface.tracks();
  const pins = surface.activePins();
  const width = surface.bankWidth();
  if (pins.size) {
    // PushDesk's view header: "PINS  bank a-b" over the free strips (its views count from 0).
    state.view = 'PINS';
    state.bank = surface.bankStart;
    state.bankWidth = width;
  }
  if (surface.mode === 'fader') {
    const bank = surface.bank();
    const taper = bank.find(Boolean)?.gain.taper?.value;
    state.unityPos = taper?.toNormalized ? taper.toNormalized(0) : 0.594;
    state.strips = Array.from({ length: 8 }, (_, i) => {
      const t = bank[i];
      const pin = pins.get(i);
      if (!t) return pin ? { i, live: false, pinned: true, missing: true, name: pin.name } : { i, live: false };
      const g = t.gain;
      const db = Number(g.real.value);
      return { i, live: true, name: t.name.value ?? '', value: Number.isFinite(db) ? db : -144, pos: g.normalized.value ?? 0, colour: hex(t.color.value), track: all.indexOf(t) + 1, selected: t === focused, touch: surface.touchedStrips.has(i), type: '', pinned: !!pin };
    });
  } else {
    const strips = surface.strips();
    const plug = PLUG_MODES.includes(surface.mode);
    const count = plug ? surface.plugParams().length : surface.freeTracks().length;
    state.knobset = {
      name: plug ? (surface.plug?.effect?.pluginName.value ?? 'no plugin') : MODE_LABEL[surface.mode],
      page: plug ? surface.plugPage : width > 0 ? Math.floor(surface.bankStart / width) : 0,
      pages: plug ? Math.max(1, Math.ceil(count / 8)) : width > 0 ? Math.max(1, Math.ceil(count / width)) : 1,
      bound: !plug || !!surface.plug?.effect,
      knobs: strips.map((s, i) => ({ i, live: !s.empty, name: s.name ?? s.missing ?? '', value: s.display ?? '', param: i + 1, index: Math.round((s.value ?? 0) * 1023), lo: -1, touch: !!s.touched, pinned: !!s.pinned, missing: s.missing !== undefined })),
    };
  }
  const meterOf = (t) => {
    const m = t?.meter;
    if (!m) return null;
    const db = (v) => (v > 0 ? Math.max(-144, 20 * Math.log10(v)) : -144);
    const lv = m.level.value ?? [], pk = m.peak.value ?? [], cl = m.clip.value ?? [];
    const legs = Math.max(1, Math.min(2, lv.length || 1));
    return [legs, db(lv[0] ?? 0), db(lv[1] ?? lv[0] ?? 0), db(pk[0] ?? 0), db(pk[1] ?? pk[0] ?? 0), cl.some(Boolean) ? 1 : 0];
  };
  const meters = { m: surface.mode === 'fader' ? Array.from({ length: 8 }, (_, i) => meterOf(surface.bank()[i])) : [], sel: meterOf(focused) };
  return { state, meters };
}

/**
 * Pins are saved with the session: session storage, context = the Add On id, one field
 * (record 'layout', field 'pins'), set in place once added, never removed and re-added (LUNA
 * can lose a record that is). Session storage writes are not undo steps.
 */
const STORE = { CONTEXT: 'com.ranrun.pushdesk_luna', RECORD: 'layout', FIELD: 'pins' };

async function loadPins(session) {
  const store = session.storage.context(STORE.CONTEXT);
  await store.load();
  return store.value(STORE.RECORD, STORE.FIELD).value ?? null;
}

async function savePins(session, data) {
  const store = session.storage.context(STORE.CONTEXT);
  await store.load();
  if (store.value(STORE.RECORD, STORE.FIELD).value === undefined) await store.add(STORE.RECORD, STORE.FIELD, data);
  else await store.set(STORE.RECORD, STORE.FIELD, data);
}

AddOnLogic.loadPins = loadPins;
AddOnLogic.savePins = savePins;
AddOnLogic.STORE = STORE;
AddOnLogic.displayState = displayState;
AddOnLogic.LED = LED;
AddOnLogic.paletteSysEx = paletteSysEx;
AddOnLogic.buttonLeds = buttonLeds;
AddOnLogic.padLeds = padLeds;
AddOnLogic.PAD_ROWS = PAD_ROWS;
AddOnLogic.Leds = Leds;
AddOnLogic.FADER = FADER;
AddOnLogic.MotorFader = MotorFader;
AddOnLogic.Driven = Driven;
AddOnLogic.PLUG_MODES = PLUG_MODES;
AddOnLogic.Gang = Gang;
AddOnLogic.gangFor = gangFor;
AddOnLogic.Surface = Surface;
globalThis.AddOnLogic = AddOnLogic;
