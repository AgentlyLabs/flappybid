// 8-bit synth SFX + music — no audio files, every sound is an oscillator
// with an envelope, in keeping with the pixel look. The AudioContext is
// created lazily because browsers only allow audio after a user gesture; the
// first flap is one, so the first sound that plays also unlocks the rest.
// A global capture-phase listener (see the mobile unlock section) re-runs
// the unlock on every tap, because iOS re-locks audio after interruptions
// and the arena's sounds arrive over the websocket, outside any gesture.
//
// SFX and music mute independently (two keys, two buttons); MUTE_KEY keeps
// its historic name so nobody's saved preference resets.

import type { MapId } from "./maps";

const MUTE_KEY = "flappybid_muted";
const MUSIC_MUTE_KEY = "flappybid_music_muted";

let ctx: AudioContext | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let muted: boolean | null = null;
let musicMuted: boolean | null = null;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // private mode etc. — the session still respects the toggle
  }
}

export function isMuted(): boolean {
  if (muted === null) muted = readFlag(MUTE_KEY);
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  writeFlag(MUTE_KEY, m);
}

export function isMusicMuted(): boolean {
  if (musicMuted === null) musicMuted = readFlag(MUSIC_MUTE_KEY);
  return musicMuted;
}

export function setMusicMuted(m: boolean): void {
  musicMuted = m;
  writeFlag(MUSIC_MUTE_KEY, m);
}

interface Audio {
  ctx: AudioContext;
  sfxBus: GainNode;
  musicBus: GainNode;
}

function audio(): Audio | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    if (!window.AudioContext) return null;
    ctx = new AudioContext();
    // Web Audio defaults to the "ambient" session on iOS, which the
    // hardware ring/silent switch mutes outright; claim "playback"
    // (iOS 17+) so the game is audible on phones that live on silent
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = "playback";
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.14; // chiptune squares are loud; keep it polite
    sfxBus.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.14;
    musicBus.connect(ctx.destination);
  }
  // not just "suspended": iOS parks the context in a nonstandard
  // "interrupted" state after a screen lock or app switch, and a
  // suspended-only check left it silent for the rest of the session
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  return { ctx, sfxBus: sfxBus!, musicBus: musicBus! };
}

// ── mobile unlock ──────────────────────────────────────────────────────
// iOS only lets resume() succeed inside a real user gesture, and the
// arena/duel foley fires from websocket handlers — so any tap or keypress
// anywhere re-unlocks the context. Deliberately a no-op until the first
// sound has been requested: browsing the site shouldn't claim an audio
// session (which would pause whatever the phone is playing).
//
// On WebKit too old for navigator.audioSession, a looping silent <audio>
// element is the classic fallback that flips the session to "playback"
// so the silent switch stops muting Web Audio.

// one PCM sample of silence; its only job is holding the audio session
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let silentEl: HTMLAudioElement | null = null;

function unlock(): void {
  if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  if ("audioSession" in navigator) return; // modern path, set in audio()
  const legacyIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS masquerades as a Mac, but Macs don't have touchscreens
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!legacyIOS) return;
  if (!silentEl) {
    silentEl = document.createElement("audio");
    silentEl.src = SILENT_WAV;
    silentEl.loop = true;
    silentEl.setAttribute("playsinline", "");
  }
  if (silentEl.paused) silentEl.play().catch(() => {});
}

if (typeof window !== "undefined") {
  // capture phase, so game handlers that stopPropagation can't starve it
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", unlock, opts);
  window.addEventListener("touchend", unlock, opts); // old iOS gesture rules
  window.addEventListener("keydown", unlock, opts);
}

interface Note {
  freq: number;
  /** seconds after the call */
  at?: number;
  dur?: number;
  type?: OscillatorType;
  /** glide to this frequency over dur */
  to?: number;
  vol?: number;
}

function scheduleNote(
  a: Audio,
  bus: GainNode,
  n: Note,
  start: number
): void {
  const dur = n.dur ?? 0.08;
  const osc = a.ctx.createOscillator();
  const gain = a.ctx.createGain();
  osc.type = n.type ?? "square";
  osc.frequency.setValueAtTime(n.freq, start);
  if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + dur);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(n.vol ?? 1, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(gain).connect(bus);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function play(notes: Note[]): void {
  if (isMuted()) return;
  const a = audio();
  if (!a) return;
  const t0 = a.ctx.currentTime;
  for (const n of notes) scheduleNote(a, a.sfxBus, n, t0 + (n.at ?? 0));
}

// Filtered-noise bursts for the combat foley — swishes, cracks and thuds
// that pure oscillators can't make. Same envelope discipline as notes.
interface NoiseBurst {
  /** bandpass center */
  freq: number;
  to?: number;
  at?: number;
  dur?: number;
  vol?: number;
  q?: number;
}

let sfxNoiseBuf: AudioBuffer | null = null;

function scheduleNoise(a: Audio, n: NoiseBurst, start: number): void {
  if (!sfxNoiseBuf) {
    sfxNoiseBuf = a.ctx.createBuffer(1, a.ctx.sampleRate / 2, a.ctx.sampleRate);
    const d = sfxNoiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const dur = n.dur ?? 0.08;
  const src = a.ctx.createBufferSource();
  src.buffer = sfxNoiseBuf;
  src.loop = true;
  const bp = a.ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = n.q ?? 1;
  bp.frequency.setValueAtTime(n.freq, start);
  if (n.to) bp.frequency.exponentialRampToValueAtTime(n.to, start + dur);
  const gain = a.ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(n.vol ?? 1, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  src.connect(bp).connect(gain).connect(a.sfxBus);
  src.start(start);
  src.stop(start + dur + 0.02);
}

function playNoise(bursts: NoiseBurst[]): void {
  if (isMuted() || bursts.length === 0) return;
  const a = audio();
  if (!a) return;
  const t0 = a.ctx.currentTime;
  for (const n of bursts) scheduleNoise(a, n, t0 + (n.at ?? 0));
}

// ── music ──────────────────────────────────────────────────────────────
// One original chiptune loop per daily map, all on an eighth-note grid:
// square (or triangle) melody, triangle bass, filtered-noise hat. 0 = rest,
// otherwise MIDI note numbers. Scheduled with the standard lookahead pattern
// (short interval, schedule ~120ms ahead) so timing never depends on rAF or
// the main thread staying smooth.

const LOOKAHEAD_SEC = 0.12;
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Tune {
  bpm: number;
  melody: number[];
  bass: number[]; // same length as melody
  melodyType?: OscillatorType; // default "square"
  melodyDur?: number; // default 0.16
  melodyVol?: number; // default 0.3
  bassDur?: number; // default 0.18
  bassVol?: number; // default 0.55
  /** does eighth-note slot i get a hi-hat? */
  hat: (i: number) => boolean;
}

// classic meadow — the original loop: 8 bars rising through C–Am–F–G and
// landing back on C so it bites its own tail cleanly.
// prettier-ignore
const CLASSIC: Tune = {
  bpm: 150,
  melody: [
    76, 0, 76, 0, 79, 0, 81, 0,   79, 0, 76, 0, 74, 0, 72, 0,
    74, 0, 76, 0, 79, 0, 76, 0,   74, 0, 72, 0, 69, 0,  0, 0,
    76, 0, 76, 0, 79, 0, 81, 0,   84, 0, 81, 0, 79, 0, 76, 0,
    74, 76, 74, 0, 72, 74, 72, 0, 72, 0, 79, 0, 84, 0,  0, 0,
  ],
  bass: [
    48, 0, 55, 0, 48, 0, 55, 0,   45, 0, 52, 0, 45, 0, 52, 0,
    41, 0, 48, 0, 41, 0, 48, 0,   43, 0, 50, 0, 43, 0, 50, 0,
    48, 0, 55, 0, 48, 0, 55, 0,   45, 0, 52, 0, 45, 0, 52, 0,
    41, 0, 48, 0, 41, 0, 48, 0,   43, 0, 50, 0, 43, 0, 50, 0,
  ],
  hat: (i) => i % 2 === 1,
};

// windy heights — a lilting waltz (6-eighth bars) drifting F–Dm–Bb–C.
// prettier-ignore
const SWAY: Tune = {
  bpm: 138,
  melody: [
    77, 0, 76, 0, 72, 0,  74, 0, 72, 0, 69, 0,  70, 0, 74, 0, 77, 0,  76, 0, 74, 0, 72, 0,
    77, 0, 81, 0, 84, 0,  81, 0, 79, 0, 77, 0,  74, 0, 77, 0, 74, 0,  72, 0,  0, 0,  0, 0,
  ],
  bass: [
    41, 0, 48, 0, 48, 0,  38, 0, 45, 0, 45, 0,  46, 0, 53, 0, 53, 0,  48, 0, 55, 0, 55, 0,
    41, 0, 48, 0, 48, 0,  38, 0, 45, 0, 45, 0,  46, 0, 53, 0, 53, 0,  48, 0, 55, 0, 55, 0,
  ],
  melodyDur: 0.22,
  hat: (i) => i % 6 === 2 || i % 6 === 4,
};

// the cavern — slow A-minor arpeggios on a soft triangle, echoing and
// sparse, with a lone drip of a hat at the end of each bar.
// prettier-ignore
const CAVERN: Tune = {
  bpm: 112,
  melody: [
    69, 0, 0, 72, 0, 0, 76, 0,   0, 0, 77, 0, 76, 0, 72, 0,
    74, 0, 0, 0, 69, 0, 0, 0,    68, 0, 64, 0, 0, 0, 0, 0,
    81, 0, 0, 79, 0, 76, 0, 0,   77, 0, 72, 0, 69, 0, 0, 0,
    74, 0, 77, 0, 74, 0, 69, 0,  71, 0, 68, 0, 64, 0, 0, 0,
  ],
  bass: [
    45, 0, 0, 0, 52, 0, 0, 0,    41, 0, 0, 0, 48, 0, 0, 0,
    38, 0, 0, 0, 45, 0, 0, 0,    40, 0, 0, 0, 47, 0, 0, 0,
    45, 0, 0, 0, 52, 0, 0, 0,    41, 0, 0, 0, 48, 0, 0, 0,
    38, 0, 0, 0, 45, 0, 0, 0,    40, 0, 0, 0, 47, 0, 0, 0,
  ],
  melodyType: "triangle",
  melodyDur: 0.3,
  melodyVol: 0.5,
  bassDur: 0.4,
  hat: (i) => i % 8 === 6,
};

// rush hour — pumping eighth-note bass under a driving mixolydian riff.
// prettier-ignore
const TURBO: Tune = {
  bpm: 176,
  melody: [
    72, 0, 72, 76, 0, 79, 76, 0,   70, 0, 70, 74, 0, 77, 74, 0,
    77, 0, 76, 0, 72, 0, 69, 0,    74, 0, 79, 0, 83, 0, 79, 0,
    72, 0, 72, 76, 0, 79, 76, 0,   70, 0, 70, 74, 0, 77, 74, 0,
    77, 0, 76, 0, 72, 0, 69, 0,    84, 0, 83, 0, 79, 0, 74, 0,
  ],
  bass: [
    48, 48, 48, 48, 55, 55, 48, 48,   46, 46, 46, 46, 53, 53, 46, 46,
    41, 41, 41, 41, 48, 48, 41, 41,   43, 43, 43, 43, 50, 50, 43, 43,
    48, 48, 48, 48, 55, 55, 48, 48,   46, 46, 46, 46, 53, 53, 46, 46,
    41, 41, 41, 41, 48, 48, 41, 41,   43, 43, 43, 43, 50, 50, 43, 43,
  ],
  melodyDur: 0.12,
  bassDur: 0.1,
  bassVol: 0.45,
  hat: (i) => i % 2 === 0,
};

// moonwalk — slow, weightless C-lydian: long triangle tones over held roots,
// barely any percussion.
// prettier-ignore
const MOON: Tune = {
  bpm: 100,
  melody: [
    76, 0, 0, 79, 0, 0, 84, 0,   78, 0, 0, 81, 0, 0, 86, 0,
    83, 0, 0, 79, 0, 0, 76, 0,   78, 0, 0, 74, 0, 0, 0, 0,
  ],
  bass: [
    48, 0, 0, 0, 0, 0, 0, 0,     50, 0, 0, 0, 0, 0, 0, 0,
    52, 0, 0, 0, 0, 0, 0, 0,     50, 0, 0, 0, 0, 0, 0, 0,
  ],
  melodyType: "triangle",
  melodyDur: 0.5,
  melodyVol: 0.55,
  bassDur: 1.1,
  hat: (i) => i % 16 === 14,
};

// the staircase — bouncy staccato G major, octave-hopping bass mirroring
// the map's climb-dive contour.
// prettier-ignore
const ZIGZAG: Tune = {
  bpm: 160,
  melody: [
    79, 0, 74, 0, 79, 0, 83, 0,   76, 0, 79, 0, 76, 0, 71, 0,
    72, 0, 76, 0, 79, 0, 76, 0,   74, 0, 78, 0, 81, 0, 78, 0,
    79, 0, 74, 0, 79, 0, 83, 0,   76, 0, 79, 0, 76, 0, 71, 0,
    72, 0, 76, 0, 79, 0, 76, 0,   86, 0, 81, 0, 78, 0, 74, 0,
  ],
  bass: [
    43, 0, 55, 0, 43, 0, 55, 0,   40, 0, 52, 0, 40, 0, 52, 0,
    36, 0, 48, 0, 36, 0, 48, 0,   38, 0, 50, 0, 38, 0, 50, 0,
    43, 0, 55, 0, 43, 0, 55, 0,   40, 0, 52, 0, 40, 0, 52, 0,
    36, 0, 48, 0, 36, 0, 48, 0,   38, 0, 50, 0, 38, 0, 50, 0,
  ],
  melodyDur: 0.1,
  hat: (i) => i % 2 === 1,
};

// the gauntlet — grim martial E minor: a clipped square riff over a
// chugging bass, marching Em–C–Am–B like something's hunting you.
// prettier-ignore
const GAUNTLET: Tune = {
  bpm: 168,
  melody: [
    76, 0, 76, 79, 0, 76, 74, 0,   72, 0, 72, 76, 0, 72, 71, 0,
    69, 0, 72, 0, 76, 0, 72, 0,    71, 0, 74, 0, 78, 0, 74, 0,
    76, 0, 76, 79, 0, 76, 74, 0,   72, 0, 72, 76, 0, 72, 71, 0,
    81, 0, 79, 0, 76, 0, 74, 0,    71, 0, 74, 0, 71, 0, 68, 0,
  ],
  bass: [
    40, 40, 40, 40, 47, 47, 40, 40,   36, 36, 36, 36, 43, 43, 36, 36,
    45, 45, 45, 45, 52, 52, 45, 45,   47, 47, 47, 47, 54, 54, 47, 47,
    40, 40, 40, 40, 47, 47, 40, 40,   36, 36, 36, 36, 43, 43, 36, 36,
    45, 45, 45, 45, 52, 52, 45, 45,   47, 47, 47, 47, 54, 54, 47, 47,
  ],
  melodyDur: 0.12,
  bassDur: 0.1,
  bassVol: 0.45,
  hat: (i) => i % 2 === 0,
};

// drone alley — a bright arcade bounce in A major, all attraction-mode
// swagger: syncopated square hooks over a walking bass.
// prettier-ignore
const ALLEY: Tune = {
  bpm: 172,
  melody: [
    81, 0, 0, 81, 83, 0, 85, 0,   81, 0, 88, 0, 85, 0, 83, 0,
    80, 0, 0, 80, 81, 0, 83, 0,   80, 0, 76, 0, 73, 0, 0, 0,
    81, 0, 0, 81, 83, 0, 85, 0,   88, 0, 90, 0, 88, 0, 85, 0,
    86, 0, 85, 0, 83, 0, 81, 0,   80, 0, 83, 0, 81, 0, 0, 0,
  ],
  bass: [
    45, 0, 52, 0, 45, 0, 52, 0,   42, 0, 49, 0, 42, 0, 49, 0,
    40, 0, 47, 0, 40, 0, 47, 0,   45, 0, 52, 0, 45, 0, 52, 0,
    45, 0, 52, 0, 45, 0, 52, 0,   42, 0, 49, 0, 42, 0, 49, 0,
    38, 0, 45, 0, 38, 0, 45, 0,   40, 0, 47, 0, 40, 0, 47, 0,
  ],
  melodyDur: 0.11,
  hat: (i) => i % 4 !== 3,
};

// the reactor — ominous E-phrygian churn: a slow heavy riff leaning on the
// flat second, long bass drones, sparse percussion like a warning klaxon.
// prettier-ignore
const REACTOR: Tune = {
  bpm: 140,
  melody: [
    64, 0, 0, 0, 65, 0, 64, 0,   67, 0, 64, 0, 62, 0, 0, 0,
    64, 0, 0, 0, 65, 0, 67, 0,   71, 0, 70, 0, 67, 0, 64, 0,
    72, 0, 0, 0, 71, 0, 67, 0,   65, 0, 64, 0, 62, 0, 0, 0,
    60, 0, 62, 0, 64, 0, 65, 0,   64, 0, 0, 0, 52, 0, 0, 0,
  ],
  bass: [
    40, 0, 0, 0, 0, 0, 0, 0,     41, 0, 0, 0, 0, 0, 0, 0,
    40, 0, 0, 0, 0, 0, 0, 0,     43, 0, 0, 0, 40, 0, 0, 0,
    36, 0, 0, 0, 0, 0, 0, 0,     41, 0, 0, 0, 0, 0, 0, 0,
    40, 0, 0, 0, 0, 0, 0, 0,     40, 0, 0, 0, 0, 0, 0, 0,
  ],
  melodyDur: 0.2,
  bassDur: 0.6,
  bassVol: 0.6,
  hat: (i) => i % 8 === 4,
};

const TUNES: Record<MapId, Tune> = {
  classic: CLASSIC,
  sway: SWAY,
  cavern: CAVERN,
  turbo: TURBO,
  moon: MOON,
  zigzag: ZIGZAG,
  gauntlet: GAUNTLET,
  alley: ALLEY,
  reactor: REACTOR,
};

let currentTune: Tune = CLASSIC;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let nextSlotTime = 0;
let slot = 0;
let noiseBuf: AudioBuffer | null = null;

function hatAt(a: Audio, start: number) {
  if (!noiseBuf) {
    noiseBuf = a.ctx.createBuffer(1, a.ctx.sampleRate * 0.05, a.ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = a.ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = a.ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 7000;
  const gain = a.ctx.createGain();
  gain.gain.setValueAtTime(0.09, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.04);
  src.connect(bp).connect(gain).connect(a.musicBus);
  src.start(start);
}

function scheduleMusic() {
  if (isMusicMuted()) return; // muted mid-run: the timer idles, silent
  const a = audio();
  if (!a) return;
  const t = currentTune;
  const eighth = 60 / t.bpm / 2;
  const now = a.ctx.currentTime;
  while (nextSlotTime < now + LOOKAHEAD_SEC) {
    // fast-forward silently past slots missed while muted or throttled
    if (nextSlotTime >= now - 0.05) {
      const i = slot % t.melody.length;
      if (t.melody[i]) {
        scheduleNote(
          a,
          a.musicBus,
          {
            freq: midiHz(t.melody[i]),
            dur: t.melodyDur ?? 0.16,
            type: t.melodyType,
            vol: t.melodyVol ?? 0.3,
          },
          nextSlotTime
        );
      }
      if (t.bass[i]) {
        scheduleNote(
          a,
          a.musicBus,
          {
            freq: midiHz(t.bass[i]),
            dur: t.bassDur ?? 0.18,
            type: "triangle",
            vol: t.bassVol ?? 0.55,
          },
          nextSlotTime
        );
      }
      if (t.hat(i)) hatAt(a, nextSlotTime);
    }
    slot += 1;
    nextSlotTime += eighth;
  }
}

/** Start (or restart) the loop for a map's tune. No-op while music is muted. */
export function startMusic(map: MapId = "classic"): void {
  if (isMusicMuted()) return;
  const a = audio();
  if (!a) return;
  const tune = TUNES[map];
  if (musicTimer !== null) {
    if (tune === currentTune) return; // already playing this map's loop
    stopMusic();
  }
  currentTune = tune;
  slot = 0;
  nextSlotTime = a.ctx.currentTime + 0.05;
  musicTimer = setInterval(scheduleMusic, 30);
}

export function stopMusic(): void {
  if (musicTimer !== null) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}

export const sfx = {
  /** wing beat: a quick upward chirp */
  flap(): void {
    play([{ freq: 340, to: 620, dur: 0.07, vol: 0.6 }]);
  },

  /**
   * Pipe cleared: a two-note coin blip. The pitch climbs a semitone per
   * pipe through each set of ten, and every tenth pipe lands a little
   * three-note fanfare instead — the run gets audibly more triumphant the
   * longer it lives.
   */
  score(n: number): void {
    if (n > 0 && n % 10 === 0) {
      play([
        { freq: 784, dur: 0.07, vol: 0.9 },
        { freq: 988, at: 0.07, dur: 0.07, vol: 0.9 },
        { freq: 1319, at: 0.14, dur: 0.22, vol: 0.9 },
      ]);
      return;
    }
    const base = 740 * Math.pow(2, (n % 10) / 12);
    play([
      { freq: base, dur: 0.05, vol: 0.75 },
      { freq: base * 1.5, at: 0.05, dur: 0.11, vol: 0.75 },
    ]);
  },

  /** the fall: a sad two-voice slide down */
  die(): void {
    play([
      { freq: 520, to: 90, dur: 0.4, type: "sawtooth", vol: 0.8 },
      { freq: 260, to: 46, dur: 0.4, vol: 0.35 },
    ]);
  },

  /** gun fired: a snappy pew, high and falling fast */
  shoot(): void {
    play([{ freq: 1150, to: 320, dur: 0.06, vol: 0.5 }]);
  },

  /** drone shot down: a bright three-note pop, distinct from the pipe blip */
  pop(): void {
    play([
      { freq: 880, dur: 0.05, vol: 0.8 },
      { freq: 1174.7, at: 0.05, dur: 0.05, vol: 0.8 },
      { freq: 1568, at: 0.1, dur: 0.14, vol: 0.8 },
    ]);
  },

  /** the mega-laser: a huge falling roar with a sizzling tail */
  beam(): void {
    play([
      { freq: 1900, to: 140, dur: 0.35, type: "sawtooth", vol: 0.55 },
      { freq: 700, to: 60, dur: 0.4, type: "square", vol: 0.3 },
      { freq: 3100, to: 2200, dur: 0.25, vol: 0.12 },
    ]);
  },

  /** laser gate opens fire: a low buzz with a high sizzle on top */
  zap(): void {
    play([
      { freq: 140, to: 88, dur: 0.25, type: "sawtooth", vol: 0.4 },
      { freq: 2300, to: 1700, dur: 0.18, vol: 0.12 },
    ]);
  },

  /**
   * Arena combat foley, one voice per weapon in the spirit of its OSRS
   * namesake: the whip snaps, the DDS double-shinks, the godsword falls
   * with a heavy whoosh and clang, the mauls land like dropped anvils.
   * The swing layer always plays; the impact layer only on a hit; a
   * matched protect swaps the impact for a metallic clank.
   */
  weaponSwing(
    key: string,
    outcome: "hit" | "blocked" | "miss" | "spec-hit" | "spec-miss"
  ): void {
    const hit = outcome === "hit" || outcome === "spec-hit";
    const notes: Note[] = [];
    const bursts: NoiseBurst[] = [];
    let impact = 0.12; // seconds until the blow lands (block clank timing)
    switch (key) {
      case "whip":
        bursts.push({ freq: 600, to: 2400, dur: 0.09, vol: 0.5, q: 1.2 });
        bursts.push({ freq: 3200, at: 0.08, dur: 0.04, vol: 1, q: 3 }); // crack
        impact = 0.15;
        if (hit) notes.push({ freq: 1700, to: 800, at: 0.15, dur: 0.06, vol: 0.5 });
        break;
      case "scim":
        bursts.push({ freq: 1500, to: 450, dur: 0.12, vol: 0.55, q: 1.2 });
        impact = 0.14;
        if (hit) {
          notes.push({ freq: 1040, to: 700, at: 0.14, dur: 0.08, vol: 0.6 });
          notes.push({ freq: 1560, at: 0.16, dur: 0.05, vol: 0.35 });
        }
        break;
      case "ags":
        bursts.push({ freq: 900, to: 200, dur: 0.24, vol: 0.6, q: 0.8 });
        notes.push({ freq: 240, to: 70, dur: 0.26, type: "sawtooth", vol: 0.4 });
        impact = 0.28;
        if (hit) {
          notes.push({ freq: 620, to: 360, at: 0.28, dur: 0.14, vol: 0.7 });
          notes.push({ freq: 930, at: 0.29, dur: 0.1, vol: 0.4 });
          bursts.push({ freq: 2400, at: 0.28, dur: 0.06, vol: 0.5, q: 2 });
        }
        break;
      case "dds":
        notes.push({ freq: 2300, to: 1300, dur: 0.045, vol: 0.55 });
        notes.push({ freq: 2500, to: 1400, at: 0.1, dur: 0.045, vol: 0.6 });
        bursts.push({ freq: 4200, dur: 0.03, vol: 0.35, q: 2 });
        bursts.push({ freq: 4200, at: 0.1, dur: 0.03, vol: 0.4, q: 2 });
        impact = 0.16;
        if (hit) notes.push({ freq: 3100, to: 1900, at: 0.16, dur: 0.05, vol: 0.5 });
        break;
      case "needle":
        notes.push({ freq: 2800, to: 1800, dur: 0.04, vol: 0.5 });
        bursts.push({ freq: 4600, dur: 0.03, vol: 0.35, q: 2 });
        impact = 0.08;
        if (hit) notes.push({ freq: 3400, to: 2200, at: 0.08, dur: 0.04, vol: 0.45 });
        break;
      case "xbow":
        notes.push({ freq: 200, to: 80, dur: 0.07, type: "triangle", vol: 0.8 });
        bursts.push({ freq: 2600, dur: 0.03, vol: 0.5, q: 2 }); // string snap
        impact = 0.16;
        if (hit) {
          notes.push({ freq: 150, to: 65, at: 0.16, dur: 0.09, type: "triangle", vol: 0.8 });
          bursts.push({ freq: 900, at: 0.16, dur: 0.05, vol: 0.5, q: 1 });
        }
        break;
      case "bow":
        // the twang, softer than the crossbeak's snap
        notes.push({ freq: 320, to: 140, dur: 0.06, type: "triangle", vol: 0.7 });
        bursts.push({ freq: 1800, dur: 0.05, vol: 0.4, q: 1.5 });
        impact = 0.18;
        if (hit) {
          notes.push({ freq: 180, to: 80, at: 0.18, dur: 0.08, type: "triangle", vol: 0.7 });
          bursts.push({ freq: 1100, at: 0.18, dur: 0.04, vol: 0.45, q: 1.2 });
        }
        break;
      case "kodai":
      case "sang":
      case "tstaff":
        // the cast: a rising shimmer, then the orb bursts on the target
        notes.push({ freq: 500, to: 1400, dur: 0.16, type: "sine", vol: 0.5 });
        bursts.push({ freq: 2200, to: 3400, dur: 0.12, vol: 0.25, q: 2 });
        impact = 0.26;
        if (hit) {
          notes.push({ freq: 1900, to: 600, at: 0.26, dur: 0.12, vol: 0.6 });
          bursts.push({ freq: 700, at: 0.26, dur: 0.08, vol: 0.5, q: 1 });
        }
        break;
      case "gmaul":
        bursts.push({ freq: 500, to: 160, dur: 0.14, vol: 0.5, q: 1 });
        impact = 0.2;
        if (hit) {
          notes.push({ freq: 150, to: 50, at: 0.2, dur: 0.14, type: "triangle", vol: 1 });
          bursts.push({ freq: 220, at: 0.2, dur: 0.1, vol: 0.8, q: 0.7 });
        }
        break;
      case "boulder":
        bursts.push({ freq: 420, to: 130, dur: 0.16, vol: 0.5, q: 0.9 });
        impact = 0.24;
        if (hit) {
          notes.push({ freq: 120, to: 45, at: 0.24, dur: 0.16, type: "triangle", vol: 1 });
          bursts.push({ freq: 180, at: 0.24, dur: 0.12, vol: 0.85, q: 0.6 });
        }
        break;
      case "elder":
        bursts.push({ freq: 400, to: 120, dur: 0.2, vol: 0.55, q: 0.8 });
        notes.push({ freq: 110, to: 45, dur: 0.3, type: "sawtooth", vol: 0.35 });
        impact = 0.3;
        if (hit) {
          notes.push({ freq: 100, to: 36, at: 0.3, dur: 0.22, type: "triangle", vol: 1 });
          notes.push({ freq: 62, at: 0.32, dur: 0.28, type: "sine", vol: 0.6 });
          bursts.push({ freq: 160, at: 0.3, dur: 0.14, vol: 0.9, q: 0.6 });
        }
        break;
      default:
        bursts.push({ freq: 1200, to: 500, dur: 0.1, vol: 0.5, q: 1 });
        if (hit) notes.push({ freq: 900, to: 500, at: 0.12, dur: 0.07, vol: 0.5 });
    }
    if (outcome === "blocked") {
      // the protect catches it: bright metallic clank, no thud
      notes.push({ freq: 1245, at: impact, dur: 0.06, vol: 0.7 });
      notes.push({ freq: 1865, at: impact + 0.04, dur: 0.05, vol: 0.5 });
    }
    if (outcome === "spec-hit" || outcome === "spec-miss") {
      // the spec announces itself over the weapon's own voice: a charging
      // sweep under a bright rising shimmer…
      notes.push({ freq: 420, to: 1680, dur: 0.16, type: "sawtooth", vol: 0.3 });
      notes.push({ freq: 1568, dur: 0.05, vol: 0.55 });
      notes.push({ freq: 2093, at: 0.05, dur: 0.05, vol: 0.55 });
      notes.push({ freq: 2637, at: 0.1, dur: 0.09, vol: 0.55 });
      bursts.push({ freq: 1600, to: 3600, dur: 0.14, vol: 0.25, q: 2 });
      if (outcome === "spec-hit") {
        // …then detonates on the beak: a deep boom under a ringing top
        notes.push({ freq: 160, to: 42, at: impact, dur: 0.22, type: "triangle", vol: 1 });
        notes.push({ freq: 2093, at: impact, dur: 0.07, vol: 0.6 });
        notes.push({ freq: 3136, at: impact + 0.06, dur: 0.12, vol: 0.5 });
        bursts.push({ freq: 500, at: impact, dur: 0.12, vol: 0.8, q: 0.8 });
      } else {
        // …or sputters out over empty sand
        notes.push({ freq: 1400, to: 240, at: impact, dur: 0.18, type: "square", vol: 0.22 });
        bursts.push({ freq: 2400, to: 700, at: impact, dur: 0.12, vol: 0.3, q: 1.5 });
      }
    }
    play(notes);
    playNoise(bursts);
  },

  /** paid revive: a bright rising power-up sweep, back from the dead */
  revive(): void {
    play([
      { freq: 330, to: 660, dur: 0.1, type: "square", vol: 0.5 },
      { freq: 523.25, at: 0.08, dur: 0.07, vol: 0.7 },
      { freq: 659.25, at: 0.15, dur: 0.07, vol: 0.7 },
      { freq: 783.99, at: 0.22, dur: 0.07, vol: 0.7 },
      { freq: 1046.5, at: 0.29, dur: 0.28, vol: 0.85 },
      { freq: 2093, at: 0.29, dur: 0.2, type: "sine", vol: 0.2 },
    ]);
  },

  /** new best today: a victory arpeggio (C E G C) */
  best(): void {
    const seq = [523.25, 659.25, 783.99, 1046.5];
    play(
      seq.map((freq, i) => ({
        freq,
        at: i * 0.09,
        dur: i === seq.length - 1 ? 0.35 : 0.09,
        vol: 0.85,
      }))
    );
  },
};
