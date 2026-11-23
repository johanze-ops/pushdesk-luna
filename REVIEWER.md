# Notes for the LUNA Add On reviewer

**What it does:** turns an Ableton Push 2 into a control surface for LUNA, in the spirit of
Push in Live or an Avid S1 in Pro Tools.

- The encoders control 8 tracks at a time, as faders or pan, with proper touch, so moves are
  single undo steps and write automation correctly.
- PLUG controls plugin parameters. It follows plugin windows opened in LUNA and the selected
  track.
- EQ and DYN jump straight to the selected track's channel strip (e.g. API Vision) sections.
- The pads do select, mute, solo and record arm, and the touch strip is the selected track's
  fader.
- Moving one of several selected tracks moves them all by the same number of dB.
- The button and pad lights show what's active.
- An optional DIY or Mackie-style single motor fader is supported.

**How it uses LUNA:** documented SDK APIs only, with no raw or undocumented engine calls.

- MIDI in: `Luna.MidiInput` on the "Ableton Push 2 Live Port", so the Add On never opens
  CoreMIDI itself.
- MIDI out: `SendMidi.sendMidiToOutput` and `sendSysExToOutput` for the button and pad lights.
- Plugins: `watchPluginWindows`, effects and parameters, and `openEditor`.
- Selection: the context's `selectionTracks` and `lastSelectedTrack`.
- Manifest: `run_hidden` (so the Push keeps working when the panel is closed), and `targets`
  editor/window/browser (so it can float over the Mixer).

**Push screen (optional helper):** an Add On can't reach USB, so the Push 2's display is drawn
by a separate helper the user installs with one Terminal line (shown in the panel with a Copy
button).

- It's a small Swift program using Apple frameworks only, run as a LaunchAgent.
- It listens only on `127.0.0.1:47829` while LUNA is running, and the Add On sends it the
  screen contents. It sends nothing over the network.
- It takes the Push screen only while PushDesk is talking to it, and releases it when LUNA
  quits, so Ableton Live can use the Push otherwise.
- Source and the uninstall line are in this repo.
- Without the helper, everything else works, and the panel shows the strips.

**Quick test (needs a Push 2):**

1. Open Add Ons > Editors > PushDesk for LUNA.
2. Turn encoders 1–8 (track volumes), and press the button above encoder 2 (PAN) or above
   encoder 4 (PLUG).
3. Press pads in the bottom rows (select/mute/solo/arm).
4. Open a plugin window in LUNA and the encoders follow it.

**Setup note for users:** the README asks users to take the Push 2 ports out of MIDI *All* in
LUNA's MIDI settings, so pads don't also play instrument tracks.

**Tested on:** LUNA 3.1.2.4693, macOS 15.6 on Apple Silicon, with a Push 2. Not tested on
Windows; the helper is macOS only.

**A wish for the SDK:** a way for Add Ons to drive a controller's display, or approved USB
access, would let this be a single install without the helper.

**Source and licence:** MIT; the bundled SDK file keeps its Apache 2.0 licence and notice. Not
affiliated with Ableton.
