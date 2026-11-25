// Runs against Luna.MockEngine: no LUNA, no Push. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const L = globalThis.AddOnLogic;

const cc = (n, v) => ({ type: 'controlChange', channel: 0, data1: n, data2: v });
const note = (n, on) => ({ type: on ? 'noteOn' : 'noteOff', channel: 0, data1: n, data2: on ? 127 : 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connected(trackCount = 10) {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: Array.from({ length: trackCount }, (_, i) => `T${i + 1}`) });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await Promise.all(session.tracks.items.map((t) => Promise.all([t.loadStrip(), t.controls.load()])));
  const surface = new L.Surface(session);
  return { engine, luna, session, surface };
}

describe('Push messages', () => {
  it('decodes relative encoders and the touch strip', () => {
    expect(L.delta(1)).toBe(1);
    expect(L.delta(3)).toBe(3);
    expect(L.delta(127)).toBe(-1);
    expect(L.delta(125)).toBe(-3);
    expect(L.stripPosition(0, 0)).toBe(0);
    expect(L.stripPosition(127, 127)).toBe(1);
  });
});

describe('plugins (PLUG knobset)', () => {
  const prop = (v) => ({ value: v, onChange: () => () => {} });
  /** A stand-in plugin parameter that records its writes and touches. */
  const param = (name, { discrete = false, steps = 0, v = 0.5 } = {}) => {
    const p = { name: prop(name), display: prop(String(v)), discrete: prop(discrete), numSteps: prop(steps), uid: prop(name), touches: [], writes: [] };
    p.normalized = { get value() { return v; }, set: async (x) => { v = x; p.writes.push(x); }, onChange: () => () => {} };
    p.begin = () => p.touches.push('on'); p.end = () => p.touches.push('off');
    return p;
  };
  const effect = (name, params) => ({ isEmpty: false, pluginName: prop(name), params, controls: { load: async () => {} }, openEditor: async () => {} });

  it('reads favourites files and puts favourites first', () => {
    const fav = L.parseFavourites('# a comment\n\nLF Gain\nhmf freq   # trailing comment\nNot A Param\n');
    expect(fav).toEqual(['LF Gain', 'hmf freq', 'Not A Param']);
    const ps = ['LF Freq', 'LF Gain', 'HMF Freq', 'Output'].map((n) => param(n));
    expect(L.orderParams(ps, fav).map((p) => p.name.value)).toEqual(['LF Gain', 'HMF Freq', 'LF Freq', 'Output']);
    expect(L.orderParams(ps, null)).toBe(ps);
  });

  it('favourites can follow a switch on the plugin (@if / @else / @end)', () => {
    const text = 'Level\n@if EQ Select = 560L\n560 31Hz\n560 63Hz\n@else\n550 LF Freq\n@end\nPower\n@if Mode != Off\nDepth\n@end';
    const at = (vals) => L.parseFavourites(text, (n) => vals[n]);
    expect(at({ 'EQ Select': '560L', Mode: 'On' })).toEqual(['Level', '560 31Hz', '560 63Hz', 'Power', 'Depth']);
    expect(at({ 'EQ Select': '550L', Mode: 'Off' })).toEqual(['Level', '550 LF Freq', 'Power']);
    expect(at({ 'EQ Select': '560l' })).toEqual(['Level', '560 31Hz', '560 63Hz', 'Power', 'Depth']); // case ignored
  });

  it('drives the plugin page by page, with favourites on and off', async () => {
    const { surface } = await connected(3);
    const ps = Array.from({ length: 12 }, (_, i) => param(`P${i + 1}`));
    surface.favourites = { Comp: ['P10', 'P2'] };
    await surface.setPlug({ name: prop('T1') }, effect('Comp', ps));
    expect(surface.mode).toBe('plug');
    expect(surface.strips().map((s) => s.name)).toEqual(['P10', 'P2', 'P1', 'P3', 'P4', 'P5', 'P6', 'P7']);
    surface.handleMidi(cc(45, 127)); // next page
    expect(surface.strips().filter((s) => !s.empty).map((s) => s.name)).toEqual(['P8', 'P9', 'P11', 'P12']);
    surface.handleMidi(cc(46, 127)); // favourites off: the plugin's own order, page 1
    expect(surface.strips()[0].name).toBe('P1');
    surface.handleMidi(note(0, true));
    await surface.handleMidi(cc(71, 4));
    surface.handleMidi(note(0, false));
    await sleep(10); // the release lands after the last write
    expect(ps[0].writes.at(-1)).toBeCloseTo(0.5 + 4 * L.step('param', false), 6);
    expect(ps[0].touches).toEqual(['on', 'off']);
  });

  it('a stepped parameter needs four detents per position', async () => {
    const { surface } = await connected(3);
    const sw = param('Mode', { discrete: true, steps: 5, v: 0 });
    await surface.setPlug({ name: prop('T1') }, effect('X', [sw]));
    for (let i = 0; i < 3; i++) await surface.handleMidi(cc(71, 1));
    expect(sw.writes.length).toBe(0);       // three detents: not yet
    await surface.handleMidi(cc(71, 1));
    expect(sw.writes.at(-1)).toBeCloseTo(0.25, 6); // the fourth: one position of five
  });

  it('down arrow flips between FADER and the last knobset', async () => {
    const { surface } = await connected(3);
    surface.handleMidi(cc(103, 127)); // PAN
    surface.handleMidi(cc(102, 127)); // FADER
    surface.handleMidi(cc(47, 127));
    expect(surface.mode).toBe('pan');
    surface.handleMidi(cc(47, 127));
    expect(surface.mode).toBe('fader');
  });

  it('lights the inserts under the display', async () => {
    const { surface } = await connected(3);
    const a = effect('EQ', [param('x')]), b = { isEmpty: true };
    surface.slots = [{ effect: a, empty: false }, { effect: b, empty: true }];
    let leds = L.buttonLeds(surface, null);
    expect(leds[20]).toBe(L.LED.SEL_DIM);
    expect(leds[21]).toBe(0);
    await surface.setPlug({ name: prop('T1') }, a);
    leds = L.buttonLeds(surface, null);
    expect(leds[20]).toBe(L.LED.SEL);
    expect(leds[105]).toBe(L.LED.SEL); // PLUG knobset on
  });
});

describe('selected faders move together', () => {
  const dbOf = (t) => t.gain.taper.value.toDb(t.gain.normalized.value);
  async function withSelection(indices) {
    const c = await connected(6);
    const ids = indices.map((i) => c.session.visibleTracks[i].id);
    await c.session.context.selectionTracks.set(ids);
    await c.session.context.lastSelectedTrack.set(ids[0]);
    await c.engine.settled();
    return c;
  }

  it('an encoder on a selected track moves every selected track by the same dB', async () => {
    const { engine, session, surface } = await withSelection([0, 2, 3]);
    const [t1, , t3, t4, t5] = session.visibleTracks;
    await t3.gain.normalized.set(t3.gain.taper.value.toNormalized(-6)); // different starting levels
    await engine.settled();
    const before = [t1, t3, t4, t5].map(dbOf);
    const setupTouches = engine.touches.length; // the -6 dB above was a touch of its own
    surface.handleMidi(note(0, true));
    for (let i = 0; i < 40; i++) await surface.handleMidi(cc(71, 1));
    surface.handleMidi(note(0, false));
    await sleep(30); await engine.settled();
    const moved = dbOf(t1) - before[0];
    expect(Math.abs(moved)).toBeGreaterThan(0.3);
    expect(dbOf(t3) - before[1]).toBeCloseTo(moved, 1);
    expect(dbOf(t4) - before[2]).toBeCloseTo(moved, 1);
    expect(dbOf(t5)).toBeCloseTo(before[3], 6); // not selected: untouched
    const during = engine.touches.slice(setupTouches);
    const ons = during.filter((x) => String(x).endsWith(':on')).length;
    const offs = during.filter((x) => String(x).endsWith(':off')).length;
    expect(ons).toBe(3);
    expect(offs).toBe(3);
  });

  it('a track that is not selected moves on its own', async () => {
    const { engine, session, surface } = await withSelection([0, 1]);
    const [t1, t2, t3] = session.visibleTracks;
    const b1 = dbOf(t1), b2 = dbOf(t2);
    surface.handleMidi(note(2, true));
    for (let i = 0; i < 20; i++) await surface.handleMidi(cc(73, 1));
    surface.handleMidi(note(2, false));
    await sleep(30); await engine.settled();
    expect(dbOf(t1)).toBeCloseTo(b1, 6);
    expect(dbOf(t2)).toBeCloseTo(b2, 6);
    expect(dbOf(t3)).not.toBeCloseTo(b1, 1);
  });

  it('a selected track at -inf stays there', async () => {
    const { engine, session, surface } = await withSelection([0, 1]);
    const [, t2] = session.visibleTracks;
    await t2.gain.normalized.set(0); await engine.settled();
    surface.handleMidi(note(0, true));
    for (let i = 0; i < 20; i++) await surface.handleMidi(cc(71, 1));
    surface.handleMidi(note(0, false));
    await sleep(30); await engine.settled();
    expect(t2.gain.normalized.value).toBe(0);
  });

  it('the touch strip moves the selection too', async () => {
    const { engine, session, surface } = await withSelection([0, 1]);
    const [t1, t2] = session.visibleTracks;
    const b1 = dbOf(t1), b2 = dbOf(t2);
    surface.handleMidi(note(12, true));
    await surface.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 40 });
    surface.handleMidi(note(12, false));
    await sleep(30); await engine.settled();
    expect(dbOf(t2) - b2).toBeCloseTo(dbOf(t1) - b1, 1);
  });
});

describe('the Push screen state (PushDesk format)', () => {
  it('describes the fader bank the way pushdesk_display.py draws it', async () => {
    const { surface, session } = await connected(10);
    const { state, meters } = L.displayState(surface, null);
    expect(state.mode).toBe('FADER');
    expect(state.strips.length).toBe(8);
    expect(state.strips[0]).toMatchObject({ i: 0, live: true, name: 'T1', track: 1, type: '' });
    expect(typeof state.strips[0].value).toBe('number');
    expect(state.strips[0].pos).toBeCloseTo(session.visibleTracks[0].gain.normalized.value, 6);
    expect(state.buttons.top.slice(0, 4)).toEqual(['FADER', 'PAN', '', 'PLUG']);
    expect(state.buttons.topOn.slice(0, 4)).toEqual([true, false, false, false]);
    expect(state.bank).toBe(1);
    expect(meters.m.length).toBe(8);
  });
  it('turns into a knobset page for PAN, with the motor fader chip', async () => {
    const { surface } = await connected(10);
    surface.handleMidi(cc(103, 127));
    const { state } = L.displayState(surface, { locked: { name: { value: 'Vox' } }, motorsOn: false });
    expect(state.mode).toBe('PAN');
    expect(state.knobset).toMatchObject({ name: 'PAN', page: 0, pages: 2, bound: true });
    expect(state.knobset.knobs[0]).toMatchObject({ live: true, name: 'T1', param: 1 });
    expect(state.mfader).toEqual({ on: true, lock: 'Vox', motorsOff: true });
  });
});

describe('button lights', () => {
  it('writes PushDesk palette entries and applies them', () => {
    const sx = L.paletteSysEx();
    expect(sx.at(-1)).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x05, 0xf7]);
    // white-dim entry: index 118, RGB 20/20/24 and W 20 (14-bit LSB first)
    expect(sx.find((m) => m[7] === 118)).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x03, 118, 20, 0, 20, 0, 24, 0, 20, 0, 0xf7]);
    expect(sx.find((m) => m[7] === 102).slice(8, 16)).toEqual([200 & 0x7f, 1, 200 & 0x7f, 1, 200 & 0x7f, 1, 90, 0]);
  });
  it('lights what can be used, bright for what is on', async () => {
    const { surface } = await connected(10);
    let leds = L.buttonLeds(surface, null);
    expect(leds[102]).toBe(L.LED.SEL);      // FADER on
    expect(leds[103]).toBe(L.LED.SEL_DIM);  // PAN available
    expect(leds[104]).toBe(0);              // unused knobset
    expect(leds[44]).toBe(0);               // no earlier bank
    expect(leds[45]).toBe(L.LED.WHITE_DIM); // a later bank exists
    expect(leds[49]).toBe(L.LED.WHITE_DIM); // Shift findable
    expect(leds[118]).toBe(0);              // Delete dark without the motor fader
    surface.handleMidi(cc(49, 127));
    expect(L.buttonLeds(surface, { locked: { id: 'x' } })[118]).toBe(L.LED.SEL);
    expect(L.buttonLeds(surface, null)[49]).toBe(L.LED.SEL);
    expect(Object.values(L.buttonLeds(surface, null, { off: true })).every((v) => v === 0)).toBe(true);
  });
  it('only sends changes, and everything again every 20th update', () => {
    const sent = [];
    const leds = new L.Leds((bytes) => sent.push(bytes));
    leds.update({ 49: 118, 102: 102 }, { 36: 107, 60: 106 | 0x100 });
    expect(sent).toEqual([[0xb0, 49, 118], [0xb0, 102, 102], [0x90, 36, 107], [0x9e, 60, 106]]); // blink on channel 15
    leds.update({ 49: 118, 102: 102 }, { 36: 107, 60: 106 | 0x100 });
    expect(sent.length).toBe(4);
    for (let i = 0; i < 17; i++) leds.update({ 49: 118, 102: 102 }, { 36: 107, 60: 106 | 0x100 });
    leds.update({ 49: 118, 102: 102 }, { 36: 107, 60: 106 | 0x100 }); // the 20th
    expect(sent.length).toBe(8);
  });
});

describe('pads', () => {
  const pad = (row, col) => 36 + row * 8 + col;
  it('mute, solo and record arm the bank tracks, and the lights follow', async () => {
    const { engine, session, surface } = await connected(10);
    const t3 = session.visibleTracks[2];
    let leds = L.padLeds(surface);
    expect(leds[pad(1, 2)]).toBe(L.LED.MUTE_DIM);
    expect(leds[pad(4, 0)]).toBe(0); // rows 5-8 dark
    surface.handleMidi(note(pad(1, 2), true));
    await sleep(20); await engine.settled();
    expect(t3.mute.on).toBe(true);
    expect(L.padLeds(surface)[pad(1, 2)]).toBe(L.LED.MUTE);
    surface.handleMidi(note(pad(2, 2), true));
    await sleep(20); await engine.settled();
    expect(t3.solo.on).toBe(true);
    surface.handleMidi(note(pad(3, 2), true));
    await sleep(20); await engine.settled();
    expect(t3.recordEnabled.value).toBe(true);
    expect(L.padLeds(surface)[pad(3, 2)]).toBe(L.LED.REC | 0x100);
  });
  it('the select row selects that track in LUNA', async () => {
    const { engine, session, surface } = await connected(10);
    surface.handleMidi(note(pad(0, 4), true));
    await sleep(20); await engine.settled();
    expect(session.focusedTrack.value).toBe(session.visibleTracks[4]);
    expect(L.padLeds(surface)[pad(0, 4)]).toBe(L.LED.SEL);
  });
  it('pads follow the bank', async () => {
    const { engine, session, surface } = await connected(10);
    surface.handleMidi(cc(45, 127)); // tracks 9-10
    surface.handleMidi(note(pad(1, 1), true));
    await sleep(20); await engine.settled();
    expect(session.visibleTracks[9].mute.on).toBe(true);
    expect(L.padLeds(surface)[pad(1, 2)]).toBe(0); // no third track in this bank
  });
});

describe('the motor fader', () => {
  async function withFader() {
    const c = await connected(3);
    const sent = [];
    const fader = new L.MotorFader(c.session, (s, a, b) => sent.push([s, a, b]));
    await fader.attach(c.session.focusedTrack.value);
    return { ...c, fader, sent };
  }
  const bendTo = (sent) => { const [, lsb, msb] = sent.at(-1); return ((msb << 7) | lsb) / 16383; };

  it('moves the motor to the track it follows', async () => {
    const { fader, sent } = await withFader();
    expect(sent.length).toBe(1);
    expect(bendTo(sent)).toBeCloseTo(fader.value(), 3);
  });

  it('a touch writes the fader, LUNA does not drive the motor meanwhile, and release snaps back', async () => {
    const { engine, fader, sent, session } = await withFader();
    const gain = session.focusedTrack.value.gain;
    fader.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 20 }); // untouched: ignored
    await engine.settled();
    const before = gain.normalized.value;
    expect(before).not.toBeCloseTo(L.stripPosition(0, 20), 2);
    fader.handleMidi(note(104, true));
    await fader.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 100 });
    await engine.settled();
    const whileTouched = sent.length;
    await sleep(80); // pace window passes: still nothing sent while touched
    expect(sent.length).toBe(whileTouched);
    fader.handleMidi(note(104, false));
    await sleep(30);
    await engine.settled();
    expect(gain.normalized.value).toBeCloseTo(L.stripPosition(0, 100), 3);
    expect(bendTo(sent)).toBeCloseTo(gain.normalized.value, 3); // snapped to LUNA's value after release
    expect(engine.touches.filter((x) => String(x).endsWith(':on')).length).toBe(1);
    expect(engine.touches.filter((x) => String(x).endsWith(':off')).length).toBe(1);
  });

  it('paces motor updates to one per 50 ms, the latest value', async () => {
    const { engine, fader, sent, session } = await withFader();
    const gain = session.focusedTrack.value.gain;
    const n0 = sent.length;
    for (const v of [0.2, 0.3, 0.4]) { await gain.normalized.set(v); await engine.settled(); }
    await sleep(80);
    expect(sent.length).toBe(n0 + 1);
    expect(bendTo(sent)).toBeCloseTo(0.4, 3);
  });

  it('utility turns the motors off and on', async () => {
    const { engine, fader, sent, session } = await withFader();
    fader.handleMidi(note(54, true));
    expect(fader.motorsOn).toBe(false);
    const n = sent.length;
    await session.focusedTrack.value.gain.normalized.set(0.1); await engine.settled(); await sleep(80);
    expect(sent.length).toBe(n);
    fader.handleMidi(note(54, true));
    expect(bendTo(sent)).toBeCloseTo(0.1, 3);
  });
});

describe('the fader bank', () => {
  it('a touched encoder moves the fader as one touch', async () => {
    const { engine, session, surface } = await connected();
    const gain = session.visibleTracks[0].gain;
    const before = gain.normalized.value;
    surface.handleMidi(note(0, true));
    for (let i = 0; i < 10; i++) await surface.handleMidi(cc(71, 1));
    surface.handleMidi(note(0, false));
    await sleep(20);
    await engine.settled();
    expect(gain.normalized.value).toBeCloseTo(before + 10 * L.step('fader', false), 5);
    const t = engine.touches.filter((x) => String(x).includes(':'));
    expect(t.filter((x) => String(x).endsWith(':on')).length).toBe(1);
    expect(t.filter((x) => String(x).endsWith(':off')).length).toBe(1);
  });

  it('an untouched turn takes a touch and lets go when it goes quiet', async () => {
    const { engine, surface, session } = await connected();
    await surface.handleMidi(cc(72, 127)); // encoder 2, one step down
    await sleep(500);
    await engine.settled();
    expect(engine.touches.filter((x) => String(x).endsWith(':on')).length).toBe(1);
    expect(engine.touches.filter((x) => String(x).endsWith(':off')).length).toBe(1);
    expect(session.visibleTracks[1].gain.normalized.value).toBeLessThan(1);
  });

  it('follows LUNA\'s selection to the bank that holds it, but leaves a hand-paged bank alone', async () => {
    const { engine, session, surface } = await connected(20);
    const ctx = session.context;
    const select = async (i) => { await ctx.selectionTracks.set([session.visibleTracks[i].id]); await ctx.lastSelectedTrack.set(session.visibleTracks[i].id); await engine.settled(); };
    await select(11);
    expect(surface.followSelection()).toBe(true);
    expect(surface.bankStart).toBe(8);                  // T9-T16 holds T12
    expect(surface.followSelection()).toBe(false);      // already on show: no move
    surface.handleMidi(cc(45, 127));                    // page by hand to T17-T20
    expect(surface.bankStart).toBe(16);
    expect(surface.followSelection(null)).toBe(false);  // nothing new selected: stays
    await select(2);
    surface.followSelection();
    expect(surface.bankStart).toBe(0);
  });

  it('pages in banks of eight and switches knobsets', async () => {
    const { surface } = await connected(10);
    expect(surface.bank().map((t) => t.name.value)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
    surface.handleMidi(cc(45, 127));
    expect(surface.bank().map((t) => t.name.value)).toEqual(['T9', 'T10']);
    surface.handleMidi(cc(45, 127)); // no further bank
    expect(surface.bankStart).toBe(8);
    surface.handleMidi(cc(44, 127));
    expect(surface.bankStart).toBe(0);
    surface.handleMidi(cc(103, 127));
    expect(surface.mode).toBe('pan');
    surface.handleMidi(cc(102, 127));
    expect(surface.mode).toBe('fader');
  });

  it('the touch strip only writes while a finger is on it', async () => {
    const { engine, session, surface } = await connected();
    const focused = session.focusedTrack.value;
    const before = focused.gain.normalized.value;
    surface.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 32 }); // no touch: ignored
    await engine.settled();
    expect(focused.gain.normalized.value).toBe(before);
    surface.handleMidi(note(12, true));
    await surface.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 100 });
    surface.handleMidi({ type: 'pitchBend', channel: 0, data1: 0, data2: 64 }); // lift-off: dead centre, before the note-off
    surface.handleMidi(note(12, false));
    await sleep(20);
    await engine.settled();
    expect(focused.gain.normalized.value).toBeCloseTo(L.stripPosition(0, 100), 3); // stays where the finger left it
  });

  it('gears like PushDesk: one 1024th per fader detent, finer with Shift', () => {
    expect(L.step('fader', false)).toBe(1 / 1024);
    expect(L.step('fader', true)).toBe(1 / 4096);
    expect(L.step('pan', false)).toBe(1 / 200);
  });
});

describe('plugins follow the selected track', () => {
  const prop = (v) => ({ value: v, onChange: () => () => {} });
  const param = (name) => ({ name: prop(name), display: prop('0'), discrete: prop(false), numSteps: prop(0), uid: prop(name), normalized: { value: 0.5, set: async () => {}, onChange: () => () => {} }, begin() {}, end() {} });
  const fx = (name, n = 12) => ({ isEmpty: false, pluginName: prop(name), pluginId: prop(name), params: Array.from({ length: n }, (_, i) => param(`${name} ${i + 1}`)), controls: { load: async () => {} }, openEditor: async () => {} });
  /** Point a mock track's plugin list at our stand-ins. */
  const withPlugins = (track, list) => {
    track.effects.load = async () => {};
    track.effects.byId = () => undefined;
    Object.defineProperty(track, 'effectSlots', { value: list, configurable: true });
    return track;
  };
  async function setup() {
    const c = await connected(4);
    const [t1, t2, t3, t4] = c.session.visibleTracks;
    withPlugins(t1, [fx('API Vision'), fx('1176')]);
    withPlugins(t2, [fx('Pro-Q'), fx('API Vision')]);
    withPlugins(t3, [fx('LA-2A'), fx('Pultec')]);
    withPlugins(t4, []);
    const select = async (t) => { await c.session.context.selectionTracks.set([t.id]); await c.session.context.lastSelectedTrack.set(t.id); await c.engine.settled(); };
    return { ...c, t1, t2, t3, t4, select };
  }

  it('moves to the same plugin on the new track, keeping the page', async () => {
    const { surface, t1, t2, select } = await setup();
    await select(t1);
    await surface.setPlug(t1, t1.effectSlots[0]); // API Vision
    surface.handleMidi(cc(45, 127));            // page 2
    await select(t2);
    await surface.followPlugin();
    expect(surface.plug.channel).toBe(t2);
    expect(surface.plug.effect.pluginName.value).toBe('API Vision');
    expect(surface.plugPage).toBe(1);
  });

  it('else the plugin in the same place, page 1', async () => {
    const { surface, t1, t3, select } = await setup();
    await select(t1);
    await surface.setPlug(t1, t1.effectSlots[1]); // 1176, second in the row
    surface.handleMidi(cc(45, 127));
    await select(t3);
    await surface.followPlugin();
    expect(surface.plug.effect.pluginName.value).toBe('Pultec');
    expect(surface.plugPage).toBe(0);
  });

  it('says so on a track with no plugins, and carries on from there', async () => {
    const { surface, t1, t2, t4, select } = await setup();
    await select(t1);
    await surface.setPlug(t1, t1.effectSlots[0]);
    await select(t4);
    await surface.followPlugin();
    expect(surface.plug.effect).toBe(null);
    expect(surface.notice).toMatch(/No plugins/);
    expect(L.displayState(surface, null).state.knobset.bound).toBe(false);
    await select(t2);
    await surface.followPlugin();
    expect(surface.plug.effect.pluginName.value).toBe('Pro-Q'); // first plugin
    expect(surface.notice).toBe(null);
  });

  it('only in PLUG mode', async () => {
    const { surface, t1, t2, select } = await setup();
    await select(t1);
    await surface.setPlug(t1, t1.effectSlots[0]);
    surface.handleMidi(cc(102, 127)); // FADER
    await select(t2);
    await surface.followPlugin();
    expect(surface.plug.channel).toBe(t1);
  });
});

describe('EQ and DYN buttons (channel strip sections)', () => {
  const prop = (v) => ({ value: v, onChange: () => () => {} });
  const param = (name, display = '0') => ({ name: prop(name), display: prop(display), discrete: prop(false), numSteps: prop(0), uid: prop(name), normalized: { value: 0.5, set: async () => {}, onChange: () => () => {} }, begin() {}, end() {} });
  const strip = (eqSelect) => ({
    isEmpty: false, pluginName: prop('Strip'), pluginId: prop('strip'), controls: { load: async () => {} }, openEditor: async () => {},
    params: [param('EQ Select', eqSelect), ...['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E1', 'E2', 'F1', 'F2', 'G1', 'G2', 'H1', 'H2'].map((n) => param(n)),
      ...Array.from({ length: 8 }, (_, i) => param(`Comp ${i + 1}`)), ...Array.from({ length: 8 }, (_, i) => param(`Gate ${i + 1}`))],
  });
  const FAV = '@section EQ\n@if EQ Select = B\nB1\nB2\nB3\n@else\nA1\nA2\n@end\n' + Array.from({ length: 6 }, (_, i) => `Pad${i}`).join('\n') +
    '\n@section DYN\n' + Array.from({ length: 8 }, (_, i) => `Comp ${i + 1}`).join('\n') + '\n@section DYN\n' + Array.from({ length: 8 }, (_, i) => `Gate ${i + 1}`).join('\n');
  const withStrip = (track, s) => { track.effects.load = async () => {}; track.effects.byId = (id) => (id === 'console' ? s : undefined); Object.defineProperty(track, 'effectSlots', { value: [], configurable: true }); return track; };
  async function setup() {
    const c = await connected(3);
    const [t1, t2, t3] = c.session.visibleTracks;
    withStrip(t1, strip('A')); withStrip(t2, strip('A')); withStrip(t3, null);
    c.surface.favourites = { Strip: FAV };
    const select = async (t) => { await c.session.context.selectionTracks.set([t.id]); await c.session.context.lastSelectedTrack.set(t.id); await c.engine.settled(); };
    await select(t1);
    return { ...c, t1, t2, t3, select };
  }

  it('reads @section markers, inside @if blocks too', () => {
    const f = L.parseFavourites(FAV, (n) => (n === 'EQ Select' ? 'B' : ''));
    expect(f.slice(0, 3)).toEqual(['B1', 'B2', 'B3']);
    expect(f.sections).toEqual({ eq: [0], dyn: [9, 17] });
  });

  it('EQ goes to the strip\'s EQ page; DYN to the compressor, then the gate, then back', async () => {
    const { surface } = await setup();
    surface.handleMidi(cc(106, 127)); await sleep(10);
    expect(surface.mode).toBe('eq');
    expect(surface.strips()[0].name).toBe('A1');
    surface.handleMidi(cc(107, 127)); await sleep(10);
    expect(surface.mode).toBe('dyn');
    expect(surface.strips()[0].name).toBe('Comp 1');
    surface.handleMidi(cc(107, 127)); await sleep(10);
    expect(surface.strips()[0].name).toBe('Gate 1');
    surface.handleMidi(cc(107, 127)); await sleep(10);
    expect(surface.strips()[0].name).toBe('Comp 1');
  });

  it('follows the selection to the same section on the next track', async () => {
    const { surface, t2, t3, select } = await setup();
    surface.handleMidi(cc(107, 127)); await sleep(10);
    surface.handleMidi(cc(107, 127)); await sleep(10); // gate
    await select(t2);
    await surface.followPlugin();
    expect(surface.plug.channel).toBe(t2);
    expect(surface.mode).toBe('dyn');
    expect(surface.strips()[0].name).toBe('Gate 1');
    await select(t3);
    await surface.followPlugin();
    expect(surface.notice).toMatch(/No channel strip/);
  });

  it('lights EQ and DYN like the other knobsets', async () => {
    const { surface } = await setup();
    surface.handleMidi(cc(106, 127)); await sleep(10);
    const leds = L.buttonLeds(surface, null);
    expect(leds[106]).toBe(L.LED.SEL);
    expect(leds[107]).toBe(L.LED.SEL_DIM);
    expect(L.displayState(surface, null).state.buttons.top.slice(4, 6)).toEqual(['EQ', 'DYN']);
  });
});

describe('pinned tracks (Layout + select pad)', () => {
  const pad = (row, col) => 36 + row * 8 + col;
  const names = (surface) => surface.bank().map((t) => t?.name.value ?? null);
  const T = (...ns) => ns.map((n) => `T${n}`);
  /** Hold Layout, press the select pads of these columns, let go. */
  const pin = (surface, ...cols) => {
    surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 127));
    for (const c of cols) surface.handleMidi(note(pad(0, c), true));
    surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 0));
  };
  const tap = (surface) => { surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 127)); surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 0)); };

  it('a pinned track stays on its strip while the others bank around it', async () => {
    const { engine, session, surface } = await connected(20);
    const before = session.context.selectionTracks.value;
    pin(surface, 0, 2);
    await sleep(20); await engine.settled();
    expect(session.context.selectionTracks.value).toEqual(before); // a pin is not a select
    expect(names(surface)).toEqual(T(1, 2, 3, 4, 5, 6, 7, 8));   // pinning moves nothing
    expect(surface.bankWidth()).toBe(6);
    surface.handleMidi(cc(45, 127));
    expect(names(surface)).toEqual(T(1, 9, 3, 10, 11, 12, 13, 14)); // pages by the six free strips
    surface.handleMidi(cc(45, 127));
    expect(names(surface)).toEqual(T(1, 15, 3, 16, 17, 18, 19, 20));
    surface.handleMidi(cc(45, 127)); // the end
    expect(surface.bankStart).toBe(12);
    surface.handleMidi(cc(44, 127));
    surface.handleMidi(cc(44, 127));
    expect(names(surface)).toEqual(T(1, 2, 3, 4, 5, 6, 7, 8));
  });

  it('pads, encoders and lights act on the tracks shown, pinned ones included', async () => {
    const { engine, session, surface } = await connected(20);
    pin(surface, 0);
    surface.handleMidi(cc(45, 127)); // T1 pinned, then T9-T15
    expect(surface.targetFor(0)).toBe(session.visibleTracks[0].gain);
    expect(surface.targetFor(1)).toBe(session.visibleTracks[8].gain);
    surface.handleMidi(note(pad(1, 0), true));
    surface.handleMidi(note(pad(1, 1), true));
    await sleep(20); await engine.settled();
    expect(session.visibleTracks[0].mute.on).toBe(true);
    expect(session.visibleTracks[8].mute.on).toBe(true);
    expect(L.padLeds(surface)[pad(1, 1)]).toBe(L.LED.MUTE);
  });

  it('a tap on Layout switches to all tracks and back, each view keeping its own bank', async () => {
    const { surface } = await connected(20);
    let saves = 0;
    surface.onPinsChange = () => saves++;
    pin(surface, 0);
    surface.handleMidi(cc(45, 127));
    expect(names(surface)).toEqual(T(1, 9, 10, 11, 12, 13, 14, 15));
    tap(surface);
    expect(surface.pinsOn).toBe(false);
    expect(names(surface)).toEqual(T(1, 2, 3, 4, 5, 6, 7, 8));
    surface.handleMidi(cc(45, 127));
    expect(names(surface)).toEqual(T(9, 10, 11, 12, 13, 14, 15, 16));
    tap(surface);
    expect(names(surface)).toEqual(T(1, 9, 10, 11, 12, 13, 14, 15));
    tap(surface);
    expect(names(surface)).toEqual(T(9, 10, 11, 12, 13, 14, 15, 16));
    // pinning with the pins off switches them back on, the old pins too
    pin(surface, 2); // T11 in the all-tracks view
    expect(surface.pinsOn).toBe(true);
    expect(names(surface)).toEqual(T(1, 9, 11, 10, 12, 13, 14, 15));
    expect(saves).toBe(5); // every pin and every tap saves
  });

  it('a tap with nothing pinned says how to pin', async () => {
    const { surface } = await connected(10);
    tap(surface);
    expect(surface.pinsOn).toBe(true);
    expect(surface.notice).toMatch(/hold Layout/);
  });

  it('selecting a track pages the free strips to it; a pinned one is already there', async () => {
    const { engine, session, surface } = await connected(20);
    const ctx = session.context;
    const select = async (i) => { await ctx.selectionTracks.set([session.visibleTracks[i].id]); await ctx.lastSelectedTrack.set(session.visibleTracks[i].id); await engine.settled(); };
    pin(surface, 0);
    await select(15);
    expect(surface.followSelection()).toBe(true);
    expect(names(surface)).toEqual([...T(1, 16, 17, 18, 19, 20), null, null]); // the end of the session
    await select(0);
    expect(surface.followSelection()).toBe(false);
    expect(surface.bankStart).toBe(14);
  });

  it('unpinning keeps the track on its strip, with its own neighbours around it', async () => {
    const { engine, session, surface } = await connected(20);
    surface.handleMidi(cc(45, 127));
    surface.handleMidi(cc(45, 127)); // T17-T20
    pin(surface, 1);                 // T18
    const ctx = session.context;
    await ctx.selectionTracks.set([session.visibleTracks[2].id]); await ctx.lastSelectedTrack.set(session.visibleTracks[2].id); await engine.settled();
    surface.followSelection();
    expect(names(surface)).toEqual(T(3, 18, 4, 5, 6, 7, 8, 9));
    pin(surface, 1);                 // unpin T18
    expect(surface.pins.size).toBe(0);
    expect(names(surface)).toEqual(T(17, 18, 19, 20));
  });

  it('a pinned track that is gone leaves its strip empty, holding its place', async () => {
    const { surface } = await connected(20);
    surface.setPins({ on: true, pins: [{ col: 2, id: 'gone', name: 'Old Vox' }, { col: 9, id: 'x' }, { col: 1 }, null] });
    expect(surface.pins.size).toBe(1); // the malformed ones are skipped
    expect(names(surface)).toEqual(['T1', 'T2', null, 'T3', 'T4', 'T5', 'T6', 'T7']);
    expect(surface.strips()[2]).toEqual({ index: 2, empty: true, pinned: true, missing: 'Old Vox' });
    const { state } = L.displayState(surface, null);
    expect(state).toMatchObject({ view: 'PINS', bank: 0, bankWidth: 7 });
    expect(state.strips[2]).toEqual({ i: 2, live: false, pinned: true, missing: true, name: 'Old Vox' });
    expect(state.strips[3]).toMatchObject({ live: true, name: 'T3', track: 3, pinned: false });
    pin(surface, 2); // Layout + its pad unpins it
    expect(surface.pins.size).toBe(0);
    expect(names(surface)).toEqual(T(1, 2, 3, 4, 5, 6, 7, 8));
  });

  it('the screen marks pins; PAN pages by the free strips', async () => {
    const { surface } = await connected(20);
    expect(L.displayState(surface, null).state.view).toBeUndefined();
    pin(surface, 0);
    let { state } = L.displayState(surface, null);
    expect(state.strips[0]).toMatchObject({ live: true, name: 'T1', pinned: true });
    expect(state.strips[1].pinned).toBe(false);
    surface.handleMidi(cc(103, 127)); // PAN
    ({ state } = L.displayState(surface, null));
    expect(state.knobset).toMatchObject({ page: 0, pages: 3 }); // 19 free tracks, 7 at a time
    expect(state.knobset.knobs[0]).toMatchObject({ name: 'T1', pinned: true, missing: false });
  });

  it('Layout lights; held, the select row shows the pins in blue', async () => {
    const { session, surface } = await connected(10);
    expect(L.buttonLeds(surface, null)[L.PUSH.LAYOUT_CC]).toBe(L.LED.WHITE_DIM);
    surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 127));
    expect(L.buttonLeds(surface, null)[L.PUSH.LAYOUT_CC]).toBe(L.LED.SEL);
    surface.handleMidi(note(pad(0, 1), true));
    const leds = L.padLeds(surface);
    expect(leds[pad(0, 1)]).toBe(L.LED.PIN);
    expect(leds[pad(0, 0)]).toBe(L.LED.PIN_DIM);
    expect(leds[pad(1, 0)]).toBe(L.LED.MUTE_DIM); // the other rows as usual
    surface.handleMidi(cc(L.PUSH.LAYOUT_CC, 0));
    const focused = session.focusedTrack.value === session.visibleTracks[1];
    expect(L.padLeds(surface)[pad(0, 1)]).toBe(focused ? L.LED.SEL : L.LED.SEL_DIM);
    expect(L.buttonLeds(surface, null)[L.PUSH.LAYOUT_CC]).toBe(L.LED.SEL); // pins on
    tap(surface);
    expect(L.buttonLeds(surface, null)[L.PUSH.LAYOUT_CC]).toBe(L.LED.WHITE_DIM); // pins off
    expect(L.paletteSysEx().map((m) => m[7])).toEqual(expect.arrayContaining([L.LED.PIN, L.LED.PIN_DIM]));
  });

  it('pins are saved with the session and come back', async () => {
    const { session, surface } = await connected(10);
    expect(await L.loadPins(session)).toBe(null);
    pin(surface, 4);
    await L.savePins(session, surface.pinsData());
    tap(surface);
    await L.savePins(session, surface.pinsData()); // set in place the second time
    const t5 = session.visibleTracks[4];
    expect(await L.loadPins(session)).toEqual({ on: false, pins: [{ col: 4, id: t5.id, name: 'T5' }] });
    const fresh = new L.Surface(session);
    fresh.setPins(await L.loadPins(session));
    expect(fresh.pinsOn).toBe(false);
    tap(fresh);
    expect(fresh.bank()[4]).toBe(t5);
  });
});

describe('the motor fader lock', () => {
  it('lets go when the locked track is deleted', async () => {
    const { session } = await connected(3);
    const fader = new L.MotorFader(session, () => {});
    await fader.attach(session.visibleTracks[1]);
    fader.toggleLock();
    expect(fader.locked).toBe(session.visibleTracks[1]);
    fader.checkLock(); // still there: stays locked
    expect(fader.locked).toBe(session.visibleTracks[1]);
    fader.locked = { id: 'deleted', name: { value: 'Gone' } };
    fader.checkLock();
    expect(fader.locked).toBe(null);
  });
});
