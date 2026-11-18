// Playback web app: multitrack stems -> routable outputs (Dante Virtual Soundcard / any multichannel device)
import { startHost, loadScript } from './remote-host.js?v=202611181546';
import { detectSections } from './guide.js?v=202611181546';
import { indexFolder, loadProject, AUDIO_RE as ABL_AUDIO } from './ableton.js?v=202611181546';
const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('pb.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('pb.' + k, JSON.stringify(v)); },
};
const S = {
  clientId: store.get('clientId', '403195791032-2167k60jjh457umlg20siumv0iu0ogph.apps.googleusercontent.com'), rootFolder: store.get('rootFolder', '1BkSjNmnFBXQtSnrepYwf5VNcxrVOXXAZ'),
  deviceId: store.get('deviceId', ''), outCount: store.get('outCount', 0),
  patch: store.get('patch', {}), outNames: store.get('outNames', []), setlist: store.get('setlist', []),
  index: store.get('index', {}),
  markers: store.get('markers', {}), trim: store.get('trim', {}), mix: store.get('mix', {}),
  presets: store.get('presets', {}), pad: store.get('pad', { out: [0, 1], vol: 0.5, key: 'C' }),
  sundays: store.get('sundays', []), activeSunday: store.get('activeSunday', null), memMode: store.get('memMode', 'economy'),
  clicks: store.get('clicks', {}), songPad: store.get('songPad', {}),
  remote: store.get('remote', { on: false, id: null, pin: null }),
  ver: store.get('ver', {}), pinned: store.get('pinned', {}), fade: store.get('fade', {}),
  arr: store.get('arr', {}), trans: store.get('trans', {}), autoDetect: store.get('autoDetect', true),
  autoAdvance: store.get('autoAdvance', true), preload: store.get('preload', true), xform: store.get('xform', {}),
};
const save = (k) => { store.set(k, S[k]); if (k === 'setlist' && typeof syncSunday === 'function') syncSunday(); };
const status = (t) => { $('#status').textContent = t; const n = $('#pfNote'); if (n && !$('#preflight').hidden) n.textContent = t; };
const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const key = (n) => n.trim().toLowerCase();

// ───────────── Audio engine ─────────────
const E = { sel: new Set(), lastSel: null, tempo: 1, markers: [], ctx: null, merger: null, master: null, nOut: 2, maxOut: 2, stems: [], song: null,
  playing: false, pos: 0, startedAt: 0, sources: [], dur: 0, masterVol: 1 };

async function initAudio() {
  if (E.ctx) { try { await E.ctx.close(); } catch {} }
  const ctx = E.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (S.deviceId && ctx.setSinkId) { try { await ctx.setSinkId(S.deviceId); } catch (e) { status('Не вдалось відкрити пристрій: ' + e.message); } }
  E.maxOut = ctx.destination.maxChannelCount || 2;
  E.nOut = Math.min(E.maxOut, S.outCount || E.maxOut, 64);
  const d = ctx.destination;
  d.channelCount = E.nOut; d.channelCountMode = 'explicit'; d.channelInterpretation = 'discrete';
  E.merger = ctx.createChannelMerger(E.nOut);
  E.master = ctx.createGain();
  Object.assign(E.master, { channelCount: E.nOut, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  E.master.gain.value = E.masterVol;
  E.merger.connect(E.master).connect(d);
  E.stems.forEach(buildStemNodes);
  $('#deviceInfo').textContent = `Sample rate ${ctx.sampleRate} Hz · пристрій дає ${E.maxOut} вих. · використовується ${E.nOut}`;
}

function routesFor(name) {
  const r = (S.patch[key(name)] ?? [0, 1]).filter((c) => c < E.nOut);
  return r;
}
function buildStemNodes(st) {
  const ctx = E.ctx;
  st.g = ctx.createGain();
  st.an = ctx.createAnalyser(); st.an.fftSize = 512;
  st.split = ctx.createChannelSplitter(2);
  st.fade = ctx.createGain();                         // song-level fade-out automation (independent of the fader)
  st.g.connect(st.fade); st.fade.connect(st.an); st.fade.connect(st.split);
  st.data = new Float32Array(st.an.fftSize);
  applyRoutes(st); applyGain(st);
}
function applyRoutes(st) {
  st.split.disconnect();
  (st.mixers ||= []).forEach((m) => m.disconnect()); st.mixers = [];
  const routes = routesFor(st.name);
  const stereo = st.channels > 1;
  if (stereo && routes.length === 1) {           // stereo -> single output: sum L+R at -6 dB each
    const h = E.ctx.createGain(); h.gain.value = 0.5; st.mixers.push(h);
    st.split.connect(h, 0); st.split.connect(h, 1); h.connect(E.merger, 0, routes[0]);
  } else routes.forEach((out, i) => st.split.connect(E.merger, stereo ? i % 2 : 0, out));
}
function applyGain(st) {
  const anySolo = E.stems.some((s) => s.solo);
  const v = st.mute || (anySolo && !st.solo) ? 0 : st.vol;
  st.g.gain.setTargetAtTime(v, E.ctx.currentTime, 0.01);
}
function setPatch(name, routes) {
  S.patch[key(name)] = [...routes].sort((a, b) => a - b); save('patch');
  E.stems.filter((s) => key(s.name) === key(name)).forEach(applyRoutes);
}

const trimOf = () => S.trim[E.song?.id] || {};
const startPos = () => (S.arr[E.song?.id] ? 0 : (trimOf().start || 0) / E.tempo);
const endPos = () => {
  const b = !S.arr[E.song?.id] && trimOf().end ? Math.min(trimOf().end / E.tempo, E.dur) : E.dur, F = fadeOf();
  return F ? Math.min(b, F.t + F.dur) : b;
};
// ── Fade-out at a chosen moment: start (song position) + duration; the song ends when the fade ends ──
function fadeOf() {
  const f = S.fade[E.song?.id]; if (!f) return null;
  const t = f.at / E.tempo; if (!(t < E.dur)) return null;
  return { t, dur: Math.max(0.3, Math.min(f.dur, E.dur - t)) };
}
const fadeV = (x) => (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;      // smooth S-curve 1 -> 0
const fadeCurve = (x0, n = 96) => Float32Array.from({ length: n }, (_, i) => fadeV(x0 + ((1 - x0) * i) / (n - 1)));
function armFade(T, pos) {                         // ctx time T corresponds to song position pos
  const F = fadeOf(); if (!E.ctx) return;
  E.stems.forEach((st) => {
    if (!st.fade) return; const g = st.fade.gain; g.cancelScheduledValues(T);
    if (!F || pos < 0) { g.setValueAtTime(1, T); return; }
    const end = F.t + F.dur;
    if (pos >= end) g.setValueAtTime(0, T);
    else if (pos >= F.t) { const x0 = (pos - F.t) / F.dur; g.setValueAtTime(fadeV(x0), T); g.setValueCurveAtTime(fadeCurve(x0), T + 0.001, end - pos - 0.001); }
    else { g.setValueAtTime(1, T); g.setValueCurveAtTime(fadeCurve(0), T + (F.t - pos), F.dur); }
  });
}
function fadeNeutral() { if (E.ctx) armFade(E.ctx.currentTime, -1); }
function position() {
  if (E.pendingJump && E.ctx.currentTime >= E.pendingJump.tb) { E.startedAt = E.pendingJump.tb - E.pendingJump.target; E.pendingJump = null; }
  return E.playing ? Math.min(E.ctx.currentTime - E.startedAt, E.dur) : E.pos;
}
// Sample-accurate jump: old sources stop at song position `at`, new ones start there from `target` (gapless section loops/queues).
function jumpAt(at, target) {
  const tb = E.startedAt + at;
  E.sources.forEach((s) => { try { s.stop(tb); } catch {} });
  E.sources.push(...E.stems.flatMap((st) => schedule(E.ctx, st, st.g, tb, target)));
  armFade(tb, target);
  E.pendingJump = { tb, target };
}
function sections() {
  const m = E.markers; if (!m.length) return [];
  return m.map((x, i) => ({ name: x.name, start: x.t, end: i + 1 < m.length ? m[i + 1].t : E.dur }));
}
const sectionAt = (p) => sections().find((s) => p >= s.start - 0.001 && p < s.end - 0.001);
async function play(lead = 0.12) {
  if (E.loading) return status('Зачекайте — пісня ще обробляється…');
  if (!E.stems.length || E.playing) return;
  await E.ctx.resume();
  const sp = S.songPad[E.song?.id]; if (sp?.auto && sp.key && P.voice?.key !== sp.key) padStart(sp.key);
  const t0 = E.ctx.currentTime + lead;
  if (E.pos >= endPos() - 0.05) E.pos = startPos();
  E.sources = E.stems.flatMap((st) => schedule(E.ctx, st, st.g, t0, E.pos));
  armFade(t0, E.pos);
  E.startedAt = t0 - E.pos; E.playing = true;
  syncPlayBtn();
}
// Schedule a stem's segments on any (Offline)AudioContext. t0 = ctx time that corresponds to song position pos.
function schedule(ctx, st, dest, t0, pos) {
  const out = [];
  for (const sg of st.segs) {
    if (sg.t + sg.d <= pos) continue;
    const skip = Math.max(0, pos - sg.t), dur = sg.d - skip;
    if (dur < 0.002) continue;
    const when = t0 + (sg.t + skip - pos);
    const src = ctx.createBufferSource(); src.buffer = sg.buffer; src.playbackRate.value = sg.rate;
    if (sg.cutIn || sg.cutOut) {
      const g = ctx.createGain(); src.connect(g); g.connect(dest);
      if (sg.cutIn && skip === 0) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.003); }
      if (sg.cutOut) { g.gain.setValueAtTime(1, when + dur - 0.003); g.gain.linearRampToValueAtTime(0, when + dur); }
    } else src.connect(dest);
    src.start(when, sg.off + skip * sg.rate, dur * sg.rate);
    out.push(src);
  }
  return out;
}
setInterval(() => {          // scheduler: queued/looped section jumps + end of song (works in background tab)
  if (!E.playing) return;
  const p = position();
  if (!E.pendingJump) {
    const sec = sectionAt(p);
    const target = E.queue ?? (E.loop && sec ? sec.start : null);
    const endT = sec ? sec.end : endPos();
    if (target != null && endT - p < 0.3 && endT - p > -0.05) {
      jumpAt(endT, target);
      if (E.queue != null) { E.queue = null; renderMarkers(); }
      return;
    }
  }
  const mode = S.trans[E.song?.id] || 'next';
  if (mode === 'fade' && !E.fading && !E.pendingJump && p >= endPos() - 3 && p < endPos() - 0.1) {
    E.fading = true; const g = E.master.gain, t = E.ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + (endPos() - p));
  }
  if (p >= endPos() - 0.05 && !E.pendingJump) { stop(); if (mode !== 'stop' && S.autoAdvance) advance(1, true); }
}, 25);
function halt() { E.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch {} }); E.sources = []; }
function pause() { if (!E.playing) return; E.pos = position(); halt(); E.playing = false; fadeNeutral(); syncPlayBtn(); }
function stop() {
  halt(); E.playing = false; E.pendingJump = null; E.queue = null; E.pos = startPos(); fadeNeutral(); syncPlayBtn();
  if (S.songPad[E.song?.id]?.auto && P.voice) { padStop(3); if ($('#padKeys')) renderPads(); }
  if (E.fading) { E.fading = false; E.master.gain.cancelScheduledValues(0); E.master.gain.setValueAtTime(E.masterVol, E.ctx.currentTime); }
}
function seek(t) { const was = E.playing; if (was) { halt(); E.playing = false; E.pendingJump = null; fadeNeutral(); } E.pos = t; if (was) play(0.03); }
function fadeOutStop(sec = 3) {
  if (!E.playing) return;
  const g = E.master.gain, t = E.ctx.currentTime;
  g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + sec);
  setTimeout(() => { stop(); g.cancelScheduledValues(E.ctx.currentTime); g.setValueAtTime(E.masterVol, E.ctx.currentTime); }, sec * 1000 + 50);
}
const syncPlayBtn = () => { $('#btnPlay').textContent = E.playing ? '❚❚' : '▶'; $('#btnPlay').classList.toggle('playing', E.playing); };

function testTone(ch) {
  if (!E.ctx || ch >= E.nOut) return;
  E.ctx.resume();
  const o = E.ctx.createOscillator(), g = E.ctx.createGain(), t = E.ctx.currentTime;
  o.frequency.value = 440; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.8);
  o.connect(g); g.connect(E.merger, 0, ch); o.start(t); o.stop(t + 0.85);
  o.onended = () => { o.disconnect(); g.disconnect(); };
}

// ───────────── Sources: Drive / local / demo ─────────────
let library = [];            // {id,name,src,load:async()=>[{name,buffer}]}
const AUDIO_RE = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff)$/i;
const stemName = (f) => f.replace(/\.[^.]+$/, '');

// Drive auth (Google Identity Services)
let token = null, tokenExp = 0;
const loadGIS = () => new Promise((res) => {
  if (window.google?.accounts?.oauth2) return res();
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; document.head.append(s);
});
loadGIS();                    // preload so the sign-in popup opens inside the click's user gesture
async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (!S.clientId) throw new Error('Вкажіть OAuth Client ID у Налаштуваннях');
  await loadGIS();
  status('Відкриваю вхід Google… якщо вікна немає — дозвольте спливаючі вікна для цього сайту');
  return new Promise((res, rej) => {
    google.accounts.oauth2.initTokenClient({
      client_id: S.clientId, scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (r) => { if (r.error) rej(new Error(r.error)); else { token = r.access_token; tokenExp = Date.now() + r.expires_in * 1000; res(token); } },
      error_callback: (e) => rej(new Error(e.type === 'popup_failed_to_open' ? 'браузер заблокував вікно входу — дозвольте спливаючі вікна (іконка у адресному рядку) і натисніть ще раз'
        : e.type === 'popup_closed' ? 'вікно входу закрито' : (e.type || 'auth error'))),
    }).requestAccessToken();
  });
}
async function dFetch(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + await getToken() } });
  if (!r.ok) throw new Error('Drive ' + r.status);
  return r;
}
async function dList(q, fields) {
  const out = []; let pt;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.search = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, orderBy: 'name',
      supportsAllDrives: true, includeItemsFromAllDrives: true, ...(pt ? { pageToken: pt } : {}) });
    const j = await (await dFetch(u)).json(); out.push(...j.files); pt = j.nextPageToken;
  } while (pt);
  return out;
}
const folderId = (s) => (s.match(/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/) || [, s.trim()])[1];

const hasToken = () => !!(token && Date.now() < tokenExp - 60000);
async function driveStemFiles(songId) {
  const cached = S.index[songId];
  if (cached?.length && !hasToken()) return cached;           // not signed in (or offline): use the file list remembered earlier
  try {
    const files = (await dList(`'${songId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      'id,name,md5Checksum,modifiedTime,size')).filter((f) => AUDIO_RE.test(f.name));
    S.index[songId] = files; save('index'); return files;
  } catch (e) { if (cached?.length) return cached; throw e; }
}
async function driveBuf(f) {
  const cache = await caches.open('stems-v1');
  const k = `https://stems.local/${f.id}/${f.md5Checksum || f.modifiedTime}`;
  const hit = await cache.match(k); if (hit) { NET.cached++; return hit.arrayBuffer(); }
  const res = await dFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`);
  const [buf] = await Promise.all([res.clone().arrayBuffer(), cache.put(k, res)]);       // cache and memory read the same stream: no extra copy
  NET.downloaded++; NET.bytes += buf.byteLength; return buf;
}
const NET = { cached: 0, downloaded: 0, bytes: 0 };
navigator.storage?.persist?.().catch(() => {});   // ask the browser not to evict cached stems
function monoIfDual(buf) {     // dual-mono stereo files -> mono (halves RAM)
  if (buf.numberOfChannels !== 2) return buf;
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return buf;
  const m = E.ctx.createBuffer(1, buf.length, buf.sampleRate); m.copyToChannel(a, 0); return m;
}
async function decodeAll(items, label, quiet = false) {            // quiet: false = status line, true = silent, function = progress callback            // items: [{name, get:()=>Promise<ArrayBuffer>}]
  let n = 0;
  return Promise.all(items.map(async (it) => {
    const ab = await it.get();
    const buffer = monoIfDual(await E.ctx.decodeAudioData(ab));
    ++n; if (typeof quiet === 'function') quiet(n, items.length); else if (!quiet) status(`${label}: ${n}/${items.length}`);
    return { name: it.name, channels: buffer.numberOfChannels, segs: [{ t: 0, d: buffer.duration, off: 0, rate: 1, buffer }] };
  }));
}

const GUIDE_RE = /guide|(^|\W)cues?$|гайд/i;
function driveEntry(f, filesFn) {
  const items = async (files, q) => decodeAll(files.map((x) => ({ name: stemName(x.name), get: () => driveBuf(x) })), f.name, q);
  return {
    id: f.id, name: f.name, src: 'drive',
    load: async (q) => items(await filesFn(), q),
    loadGuide: async (q) => items((await filesFn()).filter((x) => GUIDE_RE.test(stemName(x.name))), q),   // only the Guide stem (cheap) for section detection
    prefetch: async (cb) => {                    // 5 files at a time
      const fl = await filesFn(); if (!fl.length) throw new Error('у папці немає аудіофайлів (або немає доступу до неї)');
      const total = fl.reduce((a, x) => a + (+x.size || 0), 0); let d = 0, bytes = 0, k = 0;
      await Promise.all(Array.from({ length: Math.min(5, fl.length) }, async () => {
        while (k < fl.length) { const x = fl[k++]; await driveBuf(x); bytes += +x.size || 0; cb?.(++d, fl.length, { bytes, total }); }
      }));
    },
  };
}
async function connectDrive() {
  if (!S.rootFolder) { selectTab('settings'); return status('Вкажіть папку Drive у Налаштуваннях'); }
  status('Підключення до Drive…');
  let folders;
  try {
    folders = await dList(`'${folderId(S.rootFolder)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`, 'id,name');
    store.set('driveSongs', folders);
  } catch (e) {
    folders = store.get('driveSongs', []);
    if (!folders.length) return status('Drive: ' + e.message);
    status('Офлайн: використовую кешований список');
  }
  library = library.filter((s) => s.src !== 'drive').concat(folders.map((f) => driveEntry(f, () => driveStemFiles(f.id))));
  renderLibrary(); status(`Drive: ${folders.length} пісень`);
  syncDriveVersions(folderId(S.rootFolder));
}
function offlineDrive() {       // show cached Drive songs without login
  const folders = store.get('driveSongs', []);
  if (!folders.length) return;
  library = library.concat(folders.map((f) => driveEntry(f, () => driveStemFiles(f.id))));
}

async function openLocal() {
  if (!window.showDirectoryPicker) return status('Потрібен Chrome/Edge');
  const dir = await showDirectoryPicker();
  const audioIn = async (d) => { const a = []; for await (const [n, h] of d.entries()) if (h.kind === 'file' && AUDIO_RE.test(n)) a.push(h); return a; };
  const songs = [];
  for await (const [n, h] of dir.entries()) if (h.kind === 'directory') songs.push([n, h]);
  const own = await audioIn(dir);
  if (own.length) songs.unshift([dir.name, dir]);
  library = library.filter((s) => s.src !== 'local').concat(songs.map(([name, h]) => ({
    id: 'local:' + name, name, src: 'local', prefetch: async () => {},
    load: async (q) => decodeAll((await audioIn(h)).map((f) => ({ name: stemName(f.name), get: async () => (await f.getFile()).arrayBuffer() })), name, q),
  })));
  renderLibrary(); status(`Локально: ${songs.length} пісень`);
}

function demoSong() {
  const sr = 48000, len = sr * 24;
  const mk = (ch, fn) => { const b = E.ctx.createBuffer(ch, len, sr); for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = fn(i / sr, c); } return b; };
  const beat = 0.5; // 120 bpm
  return [
    { name: 'Click', buffer: mk(1, (t) => ((t % beat) < 0.02 ? Math.sin(2 * Math.PI * (t % (beat * 4) < beat ? 1600 : 1000) * t) * 0.5 : 0)) },
    { name: 'Guide', buffer: mk(1, (t) => ((t % 4) < 0.3 ? Math.sin(2 * Math.PI * 700 * t) * 0.3 : 0)) },
    { name: 'Drums', buffer: mk(2, (t, c) => ((t % beat) < 0.08 ? (Math.random() * 2 - 1) * 0.4 * Math.exp(-(t % beat) * 40) : 0)) },
    { name: 'Bass', buffer: mk(1, (t) => Math.sin(2 * Math.PI * 55 * t) * 0.4) },
    { name: 'Keys', buffer: mk(2, (t, c) => Math.sin(2 * Math.PI * (c ? 330 : 261.6) * t) * 0.2) },
    { name: 'Pads', buffer: mk(2, (t, c) => Math.sin(2 * Math.PI * (c ? 392 : 196) * t) * 0.15) },
    { name: 'Vox', buffer: mk(1, (t) => Math.sin(2 * Math.PI * 440 * t) * 0.15 * (Math.sin(t * 3) > 0 ? 1 : 0)) },
  ];
}

// ───────────── Song loading / setlist ─────────────
let current = null;
const XC = new Map();                 // song.id -> pre-computed key/tempo transform {key, segs[], dur}
const decoded = new Map();            // song.id -> Promise<items>; economy mode keeps current + next song only, full mode keeps all
function getItems(song, quiet) {
  if (!decoded.has(song.id)) {
    const p = Promise.resolve(song.load(quiet)).then((r) => { if (!stemsOf(r).length) throw new Error('у пісні не знайдено аудіофайлів — перевірте папку на Drive та доступ'); return r; }); decoded.set(song.id, p);
    p.catch(() => decoded.delete(song.id));
  }
  return decoded.get(song.id);
}
function preloadNext() {
  const list = S.setlist.map((id) => library.find((s) => s.id === id)).filter(Boolean);
  const nx = list[list.indexOf(current) + 1];
  if (S.memMode !== 'full') {
    const keep = new Set([current?.id, nx?.id]);
    for (const k of [...decoded.keys()]) if (!keep.has(k)) decoded.delete(k);
    for (const k of [...XC.keys()]) if (!keep.has(k)) XC.delete(k);
  }
  if (S.preload && nx && nx.src !== 'demo' && !decoded.has(nx.id)) getItems(nx, true).catch(() => {});
}
async function loadSong(song, xf) {
  const pv = pinnedVersion(song.id);
  if (pv && xf === undefined) restoreState(song.id, pv);          // pinned: always the saved Sunday version
  if (xf === undefined) xf = S.xform[song.id];
  stop(); current = song; E.loading = true; renderLibrary(); renderSetlist();
  $('#songName').textContent = song.name; $('#songMeta').textContent = 'завантаження…';
  try {
    const hadMem = decoded.has(song.id), n0 = { ...NET };
    let items = song.src === 'demo' ? demoSong() : await getItems(song);
    if (current !== song) return;
    let extra = { markers: [], warnings: [], tempo: 0, dur: 0 };
    if (!Array.isArray(items)) { extra = items; items = items.stems; }
    E.song = song; E.queue = null; E.loop = false; $('#btnLoop').classList.remove('on');
    const saved = S.mix[song.id] || {};
    E.stems = items.map((it) => {
      const segs = it.segs || [{ t: 0, d: it.buffer.duration, off: 0, rate: 1, buffer: it.buffer }];
      const sv = saved[key(it.name)];
      return { ...it, segs, channels: it.channels || segs[0].buffer.numberOfChannels, vol: sv?.vol ?? it.vol ?? 1, mute: sv?.mute ?? it.mute ?? false, solo: false };
    });
    E.dur = extra.dur || Math.max(...E.stems.flatMap((s) => s.segs.map((g) => g.t + g.d)));
    E.tempo = 1;
    if (xf && (xf.semi || xf.tempo !== 1)) {
      const xk = JSON.stringify(xf), hit = XC.get(song.id);
      if (hit && hit.key === xk && hit.segs.length === E.stems.length) { E.stems.forEach((st, i) => { st.segs = hit.segs[i]; }); E.dur = hit.dur; E.tempo = xf.tempo; }
      else { await transformStems(xf.semi, xf.tempo); XC.set(song.id, { key: xk, segs: E.stems.map((st) => st.segs), dur: E.dur }); }
    }
    if (current !== song) return;
    E.stems.forEach((st) => { st.baseSegs = st.segs; }); E.baseDur = E.dur;
    E.ablMarkers = (extra.markers || []).filter((m) => m.name && !/^\d+$/.test(m.name)); E.pos = startPos(); showTrim();
    $('#sig').textContent = song.def?.sig || '4/4';
    E.bpm = extra.tempo ? extra.tempo * E.tempo : 0; $('#bpm').textContent = E.bpm ? String(Math.round(E.bpm * 10) / 10).replace(/\.0$/, '') : '—';
    rebuildMarkers();
    E.stems.forEach(buildStemNodes);
    $('#songMeta').textContent = `${E.stems.length} стемів · ${fmt(E.dur)}` + (extra.tempo ? ` · ${extra.tempo} BPM` : '');
    renderMarkers(); renderReport(extra.warnings || []);
    syncXform(); renderMixer(); renderMatrix(); renderVersions();
    const dl = NET.downloaded - n0.downloaded, ca = NET.cached - n0.cached;
    status(hadMem ? 'Готово (з пам\'яті)' : dl ? `Готово · завантажено з Drive: ${dl} файлів, ${(((NET.bytes - n0.bytes)) / 1048576).toFixed(0)} МБ` : ca ? `Готово · з локального кешу (${ca} файлів)` : 'Готово');
    preloadNext();
    if (S.autoDetect && song.src !== 'demo' && song.src !== 'click' && !baseMarkers().length && !S.arr[song.id]) setTimeout(() => { if (current === song) detectGuide(true); }, 800);
  } catch (e) { $('#songMeta').textContent = 'помилка: ' + e.message; status('Помилка: ' + e.message); }
  finally { if (current === song) E.loading = false; }
}
function advance(d, autoplay) {
  const list = S.setlist.map((id) => library.find((s) => s.id === id)).filter(Boolean);
  const i = list.indexOf(current); const nx = list[i + d];
  if (nx) loadSong(nx).then(() => autoplay && play());
}
function addToSetlist(song) {
  if (!S.setlist.includes(song.id)) { S.setlist.push(song.id); save('setlist'); renderSetlist(); song.prefetch?.().catch(() => {}); }
}

// ───────────── UI ─────────────
function renderLibrary() {
  if (typeof renderHome === 'function') queueMicrotask(renderHome);
  const q = $('#search').value.toLowerCase();
  const ul = $('#library'); ul.innerHTML = '';
  library.filter((s) => s.name.toLowerCase().includes(q)).forEach((s) => {
    const li = document.createElement('li'); if (s === current) li.className = 'cur';
    li.innerHTML = `<span></span><button title="У сетліст">＋</button>`; li.firstChild.textContent = s.name;
    li.onclick = () => loadSong(s); li.querySelector('button').onclick = (e) => { e.stopPropagation(); addToSetlist(s); };
    ul.append(li);
  });
}
function hueOf(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function renderCards() {
  const box = $('#cards'); box.innerHTML = '';
  const list = S.setlist.map((id) => library.find((x) => x.id === id)).filter(Boolean);
  if (!list.length) { box.innerHTML = '<div class="empty">Додайте пісні в сетліст (☰♪) або відкрийте Demo</div>'; return; }
  list.forEach((sg) => {
    let ini; const h = hueOf(sg.name); ini = sg.name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const x = S.xform[sg.id], tag = x ? [x.semi ? (x.semi > 0 ? '+' : '') + x.semi + ' ст' : '', x.tempo !== 1 ? Math.round(x.tempo * 100) + '%' : ''].filter(Boolean).join(' ') : '';
    const el = document.createElement('div'); el.className = 'card' + (sg === current ? ' cur' : '');
    el.innerHTML = '<div class="art"><i></i></div><div class="nm"></div>';
    const TR = { next: ['→', 'Після пісні: наступна'], stop: ['■', 'Після пісні: зупинитись'], fade: ['↘', 'Після пісні: fade out і наступна'] };
    const ti = $('i', el), setTi = () => { const m = S.trans[sg.id] || 'next'; ti.textContent = TR[m][0]; ti.title = TR[m][1] + ' (клік — змінити)'; };
    setTi(); ti.onclick = (e) => { e.stopPropagation(); const order = ['next', 'fade', 'stop']; const m = S.trans[sg.id] || 'next'; S.trans[sg.id] = order[(order.indexOf(m) + 1) % 3]; save('trans'); setTi(); };
    if (sg.def) ini = '♩ ' + sg.def.bpm;
    const art = $('.art', el); art.style.background = `linear-gradient(135deg,hsl(${h} 52% 40%),hsl(${(h + 45) % 360} 58% 20%))`;
    art.prepend(ini); $('.nm', el).textContent = sg.name; if (tag) { const em = document.createElement('em'); em.textContent = `(${tag})`; $('.nm', el).append(em); }
    el.onclick = () => loadSong(sg); box.append(el);
  });
}
function renderSetlist() {
  renderCards();
  const ul = $('#setlist'); ul.innerHTML = '';
  S.setlist.forEach((id, i) => {
    const s = library.find((x) => x.id === id); if (!s) return;
    const li = document.createElement('li'); if (s === current) li.className = 'cur';
    li.innerHTML = `<small>${i + 1}</small><span></span><button class="up">▲</button><button class="dn">▼</button><button class="rm">✕</button>`; li.querySelector('span').textContent = s.name;
    li.onclick = () => loadSong(s);
    const mv = (d) => (e) => { e.stopPropagation(); const j = i + d; if (j < 0 || j >= S.setlist.length) return; [S.setlist[i], S.setlist[j]] = [S.setlist[j], S.setlist[i]]; save('setlist'); renderSetlist(); };
    li.querySelector('.up').onclick = mv(-1); li.querySelector('.dn').onclick = mv(1);
    li.querySelector('.rm').onclick = (e) => { e.stopPropagation(); S.setlist.splice(i, 1); save('setlist'); renderSetlist(); };
    ul.append(li);
  });
}
const routeLabel = (st) => { const r = routesFor(st.name); return r.length ? '→ ' + r.map((c) => c + 1).join('·') : 'не патчено'; };
function renderMixer() {
  const box = $('#strips'); box.innerHTML = '';
  E.stems.forEach((st) => {
    const el = document.createElement('div'); el.className = 'strip';
    el.innerHTML = `<div class="ms"><button class="s" title="Solo">S</button><button class="m" title="Mute">M</button></div>
      <div class="fader"><input type="range" min="0" max="1.5" step="0.01"><div class="meter"><i></i></div></div>
      <div class="nm"></div><div class="rt"></div>`;
    $('.nm', el).textContent = st.name; $('.rt', el).textContent = routeLabel(st);
    const f = $('input', el); f.value = st.vol; f.oninput = () => { st.vol = +f.value; applyGain(st); saveMix(); };
    f.ondblclick = () => { f.value = st.vol = 1; applyGain(st); saveMix(); };
    $('.m', el).onclick = (e) => { st.mute = !st.mute; e.target.classList.toggle('on', st.mute); applyGain(st); saveMix(); };
    $('.s', el).onclick = (e) => { st.solo = !st.solo; e.target.classList.toggle('on', st.solo); E.stems.forEach(applyGain); };
    $('.m', el).classList.toggle('on', st.mute);
    st.fEl = f; st.mEl = $('.m', el); st.sEl = $('.s', el);
    st.meter = $('.meter i', el); st.rt = $('.rt', el); box.append(el);
  });
}
function renderMatrix() {
  const n = E.nOut; const wrap = $('#matrix');
  if (!E.stems.length) { wrap.innerHTML = '<p class="hint" style="padding:12px">Спершу завантажте пісню.</p>'; return; }
  const t = document.createElement('table'); t.className = 'matrix';
  const head = t.insertRow(); head.insertCell().outerHTML = '<th class="stem">Стем ↓ / Вихід →</th>';
  for (let c = 0; c < n; c++) {
    const th = document.createElement('th'); th.className = 'out';
    th.innerHTML = `<div>${c + 1}</div><input placeholder="назва">`;
    const inp = $('input', th); inp.value = S.outNames[c] || '';
    inp.onclick = (e) => e.stopPropagation();
    inp.onchange = () => { S.outNames[c] = inp.value; save('outNames'); };
    th.onclick = () => testTone(c); head.append(th);
  }
  E.stems.forEach((st) => {
    const row = t.insertRow(); const th = document.createElement('th'); th.className = 'stem'; th.textContent = st.name; row.append(th);
    const routes = new Set(routesFor(st.name));
    for (let c = 0; c < n; c++) {
      const td = row.insertCell(); if (routes.has(c)) td.className = 'on';
      td.onclick = () => {
        routes.has(c) ? routes.delete(c) : routes.add(c);
        setPatch(st.name, routes); td.classList.toggle('on'); E.stems.forEach((s) => { if (s.rt) s.rt.textContent = routeLabel(s); });
      };
    }
  });
  wrap.innerHTML = ''; wrap.append(t);
}
function patchAll(fn) {
  E.stems.forEach((st, i) => setPatch(st.name, fn(st, i)));
  renderMatrix(); renderMixer();
}

// ── Structure model: base markers -> sections -> (optional) edited arrangement ──
const baseMarkers = () => [...(E.ablMarkers || []), ...(S.markers[E.song?.id] || [])].sort((x, y) => x.t - y.t);
function baseSections() {                       // seconds of the ORIGINAL (tempo 1) timeline
  const m = baseMarkers(); if (!m.length) return [];
  const end = E.baseDur * E.tempo, out = [];
  if (m[0].t > 1) out.push({ from: 0, to: m[0].t, name: '' });
  m.forEach((x, i) => out.push({ from: x.t, to: i + 1 < m.length ? m[i + 1].t : end, name: x.name }));
  return out.filter((x) => x.to - x.from > 0.05);
}
function mergeSegs(list) {
  list.sort((x, y) => x.t - y.t); const out = [];
  for (const g of list) {
    const p = out[out.length - 1];
    if (p && p.buffer === g.buffer && Math.abs(g.rate - p.rate) < 1e-6 && Math.abs(g.t - (p.t + p.d)) < 1e-3 && Math.abs(g.off - (p.off + p.d * p.rate)) < 2e-3) { p.d += g.d; p.cutOut = g.cutOut; }
    else out.push({ ...g });
  }
  return out;
}
function rebuildMarkers() {
  if (!E.song) return; E.sel.clear(); E.lastSel = null;
  const arr = S.arr[E.song.id], T = E.tempo;
  if (arr && arr.length) {
    let V = 0;
    const items = arr.map((it) => { const a = it.from / T, b = it.to / T, v = V; V += b - a; return { a, b, v, it }; });
    E.stems.forEach((st) => {
      const out = [];
      items.forEach((x, idx) => {
        for (const g of st.baseSegs) {
          const s0 = Math.max(g.t, x.a), e0 = Math.min(g.t + g.d, x.b); if (e0 - s0 < 0.002) continue;
          out.push({ ...g, t: x.v + (s0 - x.a), d: e0 - s0, off: g.off + (s0 - g.t) * g.rate,
            cutIn: s0 > g.t + 1e-6 || idx > 0 || g.cutIn, cutOut: e0 < g.t + g.d - 1e-6 || idx < items.length - 1 || g.cutOut });
        }
      });
      st.segs = mergeSegs(out);
    });
    E.dur = V; E.markers = items.map((x) => ({ t: x.v, name: x.it.name, t0: x.it.from }));
  } else {
    E.stems.forEach((st) => { st.segs = st.baseSegs; }); E.dur = E.baseDur;
    E.markers = baseSections().map((x) => ({ t: x.from / T, name: x.name, t0: x.from }));
  }
  computePeaks(); drawWave(); renderMarkers(); renderStructure(); renderFade();
}
const arrHist = [];
function commitArr(arr, { soft = false } = {}) {
  if (guardLock()) return;
  const id = E.song.id; arrHist.push(JSON.stringify(S.arr[id] ?? null)); if (arrHist.length > 60) arrHist.shift();
  if (arr) S.arr[id] = arr; else delete S.arr[id];
  save('arr');
  if (soft) { (arr || []).forEach((x, i) => { if (E.markers[i]) E.markers[i].name = x.name; }); renderMarkers(); renderStructure(); return; }
  if (E.playing || E.pos) stop();
  rebuildMarkers();
}
function undoArr() {
  if (guardLock()) return;
  if (!arrHist.length || !E.song) return status('Нічого скасовувати');
  const prev = JSON.parse(arrHist.pop()); const id = E.song.id;
  if (prev) S.arr[id] = prev; else delete S.arr[id];
  save('arr'); if (E.playing || E.pos) stop(); rebuildMarkers(); status('Скасовано');
}
const curArr = () => (S.arr[E.song?.id] ? S.arr[E.song.id].map((x) => ({ ...x })) : baseSections());
function opDelete(i) { if (guardLock()) return; const a = curArr(); if (a.length <= 1) return status('Не можна видалити останню секцію'); const [r] = a.splice(i, 1); commitArr(a); status(`Видалено «${r.name || 'секція'}» · скасувати: EDIT → ↶ або Cmd+Z`); }
function opDup(i) { const a = curArr(); a.splice(i + 1, 0, { ...a[i] }); commitArr(a); }
function opMove(i, d) { const a = curArr(), j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; commitArr(a); }
function opRename(i, name) { const a = curArr(); a[i].name = name; commitArr(a, { soft: true }); }
function sectionIndexAt(p) { let k = -1; E.markers.forEach((m, i) => { if (m.t <= p + 1e-6) k = i; }); return k; }
const baseAt = (i, p) => E.markers[i].t0 + (p - E.markers[i].t) * E.tempo;
function opSplit(name) {
  const p = position(), i = sectionIndexAt(p); if (i < 0) return status('Спершу додайте хоча б одну секцію');
  const a = curArr(), b = baseAt(i, p);
  if (b - a[i].from < 0.3 || a[i].to - b < 0.3) return status('Занадто близько до межі секції');
  a.splice(i, 1, { ...a[i], to: b }, { from: b, to: a[i].to, name: name ?? ((a[i].name || '') + ' 2').trim() }); commitArr(a);
}
function opSetStart(i) {                         // boundary between section i-1 and i := playhead
  const p = position(), k = sectionIndexAt(p), a = curArr();
  if (i < 1 || (k !== i && k !== i - 1)) return status('Поставте курсор всередині цієї секції або попередньої');
  const b = baseAt(k, p);
  if (Math.abs(a[i - 1].to - a[i].from) > 1e-3) return status('Секції не суміжні — межу не можна зсунути');
  if (b <= a[i - 1].from + 0.3 || b >= a[i].to - 0.3) return status('Занадто близько до іншої межі');
  a[i - 1].to = b; a[i].from = b; commitArr(a);
}
function opMergeNext(i) {
  const a = curArr(); if (i + 1 >= a.length) return;
  if (Math.abs(a[i].to - a[i + 1].from) > 1e-3) return status('Секції не суміжні — об’єднати не можна');
  a[i].to = a[i + 1].to; a.splice(i + 1, 1); commitArr(a);
}
function resetStructure() { if (!E.song) return; if (!S.arr[E.song.id]) return status('Структура вже початкова'); commitArr(null); status('Структуру скинуто до початкової'); }

function renderStructure() {
  const box = $('#structList'); if (!box) return;
  box.innerHTML = ''; E.sel.forEach((i) => { if (i >= E.markers.length) E.sel.delete(i); });
  if (!E.markers.length) { box.innerHTML = '<p class="hint">Секцій ще немає. Натисніть «Визначити по Guide» або «＋ Секція тут».</p>'; return; }
  E.markers.forEach((m, i) => {
    const next = E.markers[i + 1] ? E.markers[i + 1].t : E.dur, info = secInfo(m.name);
    const row = document.createElement('div'); row.className = 'srow';
    row.innerHTML = `<input type="checkbox" class="ck" title="Вибрати (Shift — діапазон)"><span class="sb"></span><input class="sn" placeholder="назва"><span class="st"></span>
      <button class="go" title="Перейти">▶</button><button class="up" title="Вгору">▲</button><button class="dn" title="Вниз">▼</button>
      <button class="dup" title="Дублювати (повторити секцію)">⧉</button><button class="ss" title="Початок секції = позиція курсору">⇤</button>
      <button class="mg" title="Об’єднати з наступною">⤵</button><button class="del" title="Видалити секцію">✕</button>`;
    $('.ck', row).onclick = (e) => { e.stopPropagation(); if (e.shiftKey && E.lastSel != null) selectSection(i, e); else { E.sel.has(i) ? E.sel.delete(i) : E.sel.add(i); E.lastSel = i; refreshSel(); } };
    if (E.sel.has(i)) row.classList.add('sel');
    const sb = $('.sb', row); sb.textContent = info.code; sb.style.setProperty('--c', info.color);
    const inp = $('.sn', row); inp.value = m.name; inp.onchange = () => opRename(i, inp.value.trim());
    $('.st', row).textContent = `${fmt(m.t)}–${fmt(next)} (${fmt(next - m.t)})`;
    $('.go', row).onclick = () => { E.queue = null; seek(m.t); };
    $('.up', row).onclick = () => opMove(i, -1); $('.dn', row).onclick = () => opMove(i, 1);
    $('.dup', row).onclick = () => opDup(i); $('.ss', row).onclick = () => opSetStart(i);
    $('.mg', row).onclick = () => opMergeNext(i); $('.del', row).onclick = () => opDelete(i);
    box.append(row);
  });
  refreshSel();
}

// ── Fade-out UI ──
function renderFade() {
  const F = fadeOf(), el = $('#fadeMark'), tail = $('#fadeTail');
  const has = !!S.fade[E.song?.id];
  el.hidden = tail.hidden = !F;
  $('#fadeInfo').textContent = !E.song ? '' : F ? `Fade out: з ${fmt(F.t)}, ${F.dur.toFixed(1)} с → пісня закінчується о ${fmt(F.t + F.dur)}` : has ? 'Позначка fade-out поза межами пісні (структуру змінено) — задайте заново' : 'Fade-out не задано — пісня грає до кінця';
  if (!F || !E.dur) return;
  el.style.left = (F.t / E.dur) * 100 + '%'; el.style.width = (F.dur / E.dur) * 100 + '%';
  tail.style.left = ((F.t + F.dur) / E.dur) * 100 + '%'; tail.style.width = (100 - ((F.t + F.dur) / E.dur) * 100) + '%';
  $('#fadeDur').value = S.fade[E.song.id].dur;
}
function setFade(at, dur) {
  if (!E.song || guardLock()) return;
  S.fade[E.song.id] = { at: Math.round(at * E.tempo * 100) / 100, dur: Math.max(0.5, Math.min(60, dur || 4)) }; save('fade');
  renderFade(); if (E.playing) armFade(E.ctx.currentTime + 0.02, position());
}
$('#fadeSet').onclick = () => setFade(position(), +$('#fadeDur').value || 4);
$('#fadeSecEnd').onclick = () => {
  const sc = sectionAt(position()); if (!sc) return status('Немає секції в позиції курсору');
  const d = +$('#fadeDur').value || 4; setFade(Math.max(0, sc.end - d), d);
};
$('#fadeDur').onchange = () => { const F = fadeOf(); if (F) setFade(F.t, +$('#fadeDur').value || 4); };
$('#fadeClear').onclick = () => { if (!E.song || guardLock()) return; delete S.fade[E.song.id]; save('fade'); renderFade(); if (E.playing) armFade(E.ctx.currentTime + 0.02, position()); };
$('#fadeTest').onclick = () => { const F = fadeOf(); if (!F) return status('Fade-out не задано'); seek(Math.max(0, F.t - 4)); if (!E.playing) play(); };

// ── Multi-select of sections (Shift = range, Ctrl/Cmd = toggle) ──
const locked = () => !!S.pinned[E.song?.id];
function guardLock() { if (locked()) { status('🔒 Пісню закріплено (версія «' + (S.ver[E.song.id]?.main || '') + '»). Зніміть закріплення в EDIT → «Версії», щоб змінювати'); return true; } return false; }
function selectSection(i, e) {
  if (e.shiftKey && E.lastSel != null) { const [a, b] = [Math.min(E.lastSel, i), Math.max(E.lastSel, i)]; for (let k = a; k <= b; k++) E.sel.add(k); }
  else if (e.metaKey || e.ctrlKey || E.sel.size) { E.sel.has(i) ? E.sel.delete(i) : E.sel.add(i); E.lastSel = i; }
  else { E.sel.add(i); E.lastSel = i; }
  refreshSel();
}
function clearSel() { E.sel.clear(); E.lastSel = null; refreshSel(); }
function refreshSel() {
  document.querySelectorAll('#sections .sec').forEach((el, i) => el.classList.toggle('sel', E.sel.has(i)));
  document.querySelectorAll('#structList .srow').forEach((el, i) => { el.classList.toggle('sel', E.sel.has(i)); const c = $('.ck', el); if (c) c.checked = E.sel.has(i); });
  $('#selbar').hidden = !E.sel.size; $('#selInfo').textContent = `Вибрано секцій: ${E.sel.size}`;
}
function opDeleteMany(idx) {
  if (guardLock()) return;
  const set = new Set(idx); if (!set.size) return;
  const a = curArr(); if (set.size >= a.length) return status('Не можна видалити всі секції');
  const names = [...set].sort((x, y) => x - y).map((i) => a[i]?.name || 'секція');
  commitArr(a.filter((_, i) => !set.has(i))); E.sel.clear(); E.lastSel = null; refreshSel();
  status(`Видалено ${set.size}: ${names.join(', ')} · скасувати: Cmd+Z`);
}
$('#selDel').onclick = () => opDeleteMany([...E.sel]);
$('#selClear').onclick = clearSel;
addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.code === 'Delete' || e.code === 'Backspace') && E.sel.size) { e.preventDefault(); opDeleteMany([...E.sel]); }
  if (e.code === 'Escape' && E.sel.size) clearSel();
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyA' && E.markers.length && !$('#overlay').hidden === false) { e.preventDefault(); E.markers.forEach((_, i) => E.sel.add(i)); refreshSel(); }
});

// ── Saved versions (what is played every Sunday), pinning, export/import, sharing via Drive ──
function snapshot() {
  const id = E.song.id;
  return JSON.parse(JSON.stringify({ arr: S.arr[id] || null, markers: S.markers[id] || [], xform: S.xform[id] || null, mix: S.mix[id] || {}, trans: S.trans[id] || 'next', trim: S.trim[id] || null, fade: S.fade[id] || null, pad: S.songPad[id] || null, savedAt: Date.now() }));
}
function restoreState(id, sn) {
  const set = (k, v, empty) => { if (v == null || (empty && empty(v))) delete S[k][id]; else S[k][id] = JSON.parse(JSON.stringify(v)); save(k); };
  set('arr', sn.arr); set('markers', sn.markers, (v) => !v.length); set('xform', sn.xform); set('mix', sn.mix, (v) => !Object.keys(v).length);
  set('trans', sn.trans && sn.trans !== 'next' ? sn.trans : null); set('trim', sn.trim); set('fade', sn.fade); set('songPad', sn.pad);
}
function pinnedVersion(id) { const v = S.ver[id]; return S.pinned[id] && v && v.list[v.main] ? v.list[v.main] : null; }
function renderVersions() {
  const sel = $('#verSel'); if (!sel) return;
  const id = E.song?.id, v = (id && S.ver[id]) || { list: {}, main: null };
  const prev = sel.value; sel.innerHTML = '<option value="">— збережені версії —</option>';
  Object.entries(v.list).sort((a, b) => b[1].savedAt - a[1].savedAt).forEach(([n, sn]) => sel.append(new Option(`${v.main === n ? '★ ' : ''}${n} · ${new Date(sn.savedAt).toLocaleDateString('uk')}`, n)));
  if (v.list[prev]) sel.value = prev; else if (v.main) sel.value = v.main;
  $('#chkPin').checked = !!(id && S.pinned[id]);
  $('#verInfo').textContent = !id ? '' : S.pinned[id] ? `🔒 Закріплено: щоразу відкривається версія «${v.main}»; зміни структури/тону заблоковані (гучності можна міняти під час служби — вони не зберігаються).` : Object.keys(v.list).length ? 'Версія не закріплена: відкривається останній робочий стан.' : 'Ще немає збережених версій.';
}
function saveVersion(name) {
  if (!E.song) return; if (!name) { name = prompt('Назва версії (напр. «Неділя», «Різдво, G»):', 'Неділя'); if (!name) return; }
  const v = S.ver[E.song.id] ||= { list: {}, main: null };
  v.list[name] = snapshot(); if (!v.main) v.main = name; save('ver'); renderVersions(); $('#verSel').value = name; status(`Версію «${name}» збережено`);
}
$('#verSave').onclick = () => saveVersion();
$('#verOverwrite').onclick = () => { const n = $('#verSel').value; if (n && confirm(`Перезаписати «${n}» поточним станом?`)) saveVersion(n); };
$('#verApply').onclick = () => {
  const id = E.song?.id, n = $('#verSel').value, sn = id && S.ver[id]?.list[n]; if (!sn) return;
  if (locked()) return guardLock();
  restoreState(id, sn); loadSong(E.song.src === 'demo' ? E.song : current, sn.xform || null); status(`Застосовано версію «${n}»`);
};
$('#verMain').onclick = () => { const id = E.song?.id, n = $('#verSel').value; if (!id || !n) return; S.ver[id].main = n; save('ver'); renderVersions(); status(`Основна версія: «${n}»`); };
$('#verDelete').onclick = () => {
  const id = E.song?.id, n = $('#verSel').value; if (!id || !n || !confirm(`Видалити версію «${n}»?`)) return;
  const v = S.ver[id]; delete v.list[n]; if (v.main === n) { v.main = Object.keys(v.list)[0] || null; if (!v.main) delete S.pinned[id]; }
  save('ver'); save('pinned'); renderVersions();
};
$('#chkPin').onchange = (e) => {
  const id = E.song?.id; if (!id) { e.target.checked = false; return; }
  if (e.target.checked) {
    const v = S.ver[id]; if (!v || !v.main) saveVersion('Основна');
    S.pinned[id] = true; save('pinned'); const sn = pinnedVersion(id);
    if (sn) { restoreState(id, sn); loadSong(current, sn.xform || null); }
  } else { delete S.pinned[id]; save('pinned'); }
  renderVersions();
};
function exportData() { return { format: 'ubc-playback-versions', v: 1, exportedAt: Date.now(), ver: S.ver, pinned: S.pinned, clicks: S.clicks, sundays: S.sundays, songs: Object.fromEntries(library.map((l) => [l.id, l.name])) }; }
function mergeVersions(d) {
  if (!d || d.format !== 'ubc-playback-versions') throw new Error('Це не файл версій Playback');
  let n = 0;
  for (const [id, c] of Object.entries(d.clicks || {})) if (!S.clicks[id] || (c.updated || 0) > (S.clicks[id].updated || 0)) { S.clicks[id] = c; n++; }
  if (d.clicks) { save('clicks'); syncClickLibrary(); }
  for (const sn of d.sundays || []) { const mine = S.sundays.find((x) => x.id === sn.id); if (!mine) { S.sundays.push(sn); n++; } else if ((sn.updated || 0) > (mine.updated || 0)) { Object.assign(mine, sn); n++; } }
  if (d.sundays) { store.set('sundays', S.sundays); if (typeof renderHome === 'function') renderHome(); }
  for (const [id, v] of Object.entries(d.ver || {})) {
    const mine = S.ver[id] ||= { list: {}, main: v.main };
    for (const [name, sn] of Object.entries(v.list || {})) if (!mine.list[name] || (sn.savedAt || 0) > (mine.list[name].savedAt || 0)) { mine.list[name] = sn; n++; }
    if (!mine.main || !mine.list[mine.main]) mine.main = v.main;
    else if (v.main && v.list[v.main] && (v.list[v.main].savedAt || 0) > (mine.list[mine.main].savedAt || 0)) mine.main = v.main;
    if ((d.pinned || {})[id]) S.pinned[id] = true;
  }
  save('ver'); save('pinned'); return n;
}
$('#verExport').onclick = async () => {
  const text = JSON.stringify(exportData(), null, 1);
  try {
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: 'playback-versions.json', types: [{ description: 'Playback versions', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close(); status('Версії збережено у файл');
    } else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'playback-versions.json'; a.click(); }
  } catch (e) { if (e.name !== 'AbortError') status('Експорт: ' + e.message); }
};
$('#verImport').onclick = () => $('#verFile').click();
$('#verFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const n = mergeVersions(JSON.parse(await f.text())); renderVersions(); status(`Імпортовано версій: ${n}`); if (E.song && pinnedVersion(E.song.id)) loadSong(current); }
  catch (err) { status('Імпорт: ' + err.message); }
};
async function syncDriveVersions(root) {            // playback-versions.json placed in the Drive playback folder is shared by all leaders
  try {
    const f = (await dList(`'${root}' in parents and name='playback-versions.json' and trashed=false and mimeType!='application/vnd.google-apps.folder'`, 'id,modifiedTime'))[0];
    if (!f) return;
    const d = await (await dFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`)).json();
    store.set('driveVer', d); const n = mergeVersions(d); if (n) status(`З Drive підтягнуто версій: ${n}`);
  } catch {}
}
{ const d = store.get('driveVer', null); if (d) { try { mergeVersions(d); } catch {} } }

// ── Section detection from the Guide stem (whisper in a worker) ──
const ASR = { w: null, ready: null, id: 0, pend: new Map() };
function asrInit() {
  if (ASR.ready) return ASR.ready;
  ASR.w = new Worker('asr-worker.js?v=' + (document.querySelector('script[src*="app.js"]').src.split('v=')[1] || '1'), { type: 'module' });
  ASR.ready = new Promise((res, rej) => {
    ASR.w.onmessage = ({ data: d }) => {
      if (d.type === 'ready') res();
      else if (d.type === 'progress') status(`Модель розпізнавання: ${Math.round(d.pct || 0)}% (${(d.file || '').split('/').pop()})`);
      else if (d.type === 'text') ASR.pend.get(d.id)?.res(d.text);
      else if (d.type === 'error') { if (d.id) ASR.pend.get(d.id)?.rej(new Error(d.message)); else { ASR.ready = null; rej(new Error(d.message)); } }
    };
    ASR.w.onerror = (e) => { ASR.ready = null; rej(new Error(e.message || 'не вдалось запустити розпізнавання')); };
  });
  ASR.w.postMessage({ type: 'init' });
  return ASR.ready;
}
const asrText = (a) => new Promise((res, rej) => { const i = ++ASR.id; ASR.pend.set(i, { res, rej }); ASR.w.postMessage({ type: 'transcribe', id: i, audio: a }, [a.buffer]); });
function guideSamplesFrom(segs, dur) {
  const sr = 16000, n = Math.ceil(dur * sr), x = new Float32Array(n);
  for (const g of segs) {
    const ch = g.buffer.getChannelData(0), bsr = g.buffer.sampleRate;
    const i0 = Math.max(0, Math.floor(g.t * sr)), i1 = Math.min(n, Math.floor((g.t + g.d) * sr));
    for (let i = i0; i < i1; i++) {
      const src = Math.floor((g.off + (i / sr - g.t) * g.rate) * bsr); let acc = 0, c = 0;
      for (let k = 0; k < 3 && src + k < ch.length; k++) { acc += ch[src + k]; c++; }
      x[i] = c ? acc / c : 0;
    }
  }
  return x;
}
function guideSamples() {
  const st = E.stems.find((x) => GUIDE_RE.test(x.name)); if (!st) return null;
  return guideSamplesFrom(st.baseSegs, E.baseDur);
}
async function detectGuide(auto = false) {
  if (!E.song || E.detecting || guardLock()) return;
  const x = guideSamples();
  if (!x) { if (!auto) status('Не знайшов стем Guide/Cue у цій пісні'); return; }
  const song = E.song; E.detecting = true; $('#btnDetect').disabled = true;
  try {
    status('Завантажую модель розпізнавання мови (перший раз ~40 МБ, далі з кешу)…'); await asrInit();
    status('Слухаю Guide…');
    const res = await detectSections(x, 16000, asrText, (d, t) => status(`Guide: розпізнано ${d}/${t}`));
    if (E.song !== song) return;
    if (!res.length) return status('У Guide не знайдено голосових підказок секцій');
    const mine = (S.markers[song.id] || []).filter((m) => !m.auto);
    S.markers[song.id] = [...mine, ...res.map((r) => ({ t: Math.round(r.t * E.tempo * 100) / 100, name: r.name, auto: true }))]; save('markers');
    delete S.arr[song.id]; save('arr'); arrHist.length = 0; rebuildMarkers();
    status(`Секції визначено по Guide: ${res.length}`);
  } catch (e) { status('Guide: ' + e.message); }
  finally { E.detecting = false; $('#btnDetect').disabled = false; }
}

const SEC_COLORS = { I: '#9b6bff', V: '#4c9dff', Pc: '#ffb020', C: '#22d6a0', B: '#ff6bb5', Tg: '#ff8a4c', O: '#8a91a2', In: '#4dd0e1' };
function secInfo(name) {
  const n = (name || '').trim(), l = n.toLowerCase(), num = (l.match(/(\d+)\s*$/) || [])[1] || '';
  const T = [[/intro|вступ/, 'I'], [/pre|пре/, 'Pc'], [/verse|куплет|^v\d*$/, 'V'], [/chorus|приспів|^c\d*$/, 'C'], [/bridge|брідж|^b\d*$/, 'B'], [/tag|тег/, 'Tg'], [/outro|кінц|^end/, 'O'], [/inst|інстр/, 'In']];
  for (const [re, code] of T) if (re.test(l)) return { code: code + (['I', 'O', 'Tg', 'In'].includes(code) ? '' : num), color: SEC_COLORS[code] };
  return { code: n.slice(0, 3) || '•', color: '#8a91a2' };
}
function renderMarkers() {
  const box = $('#sections'); box.innerHTML = '';
  if (!E.dur) return;
  sections().forEach((sc, i) => {
    const m = E.markers[i], info = secInfo(sc.name);
    const el = document.createElement('div'); el.className = 'sec'; if (E.queue === sc.start) el.classList.add('queued');
    el.style.cssText = `left:${(sc.start / E.dur) * 100}%;width:${((sc.end - sc.start) / E.dur) * 100}%;--c:${info.color}`;
    el.innerHTML = '<div class="bg"></div><div class="bar"></div><div class="badge"></div>';
    const b = $('.badge', el); b.textContent = info.code;
    b.title = `${sc.name || 'секція'} · ${fmt(sc.start)}\nКлік — перейти в кінці поточної секції; подвійний клік — одразу; Shift/Ctrl+клік — вибрати кілька (потім Delete); ПКМ — видалити`;
    el.classList.toggle('sel', E.sel.has(i));
    b.onclick = (e) => {
      e.stopPropagation();
      if (e.shiftKey || e.metaKey || e.ctrlKey || E.sel.size) return selectSection(i, e);
      if (E.playing) { E.queue = sc.start; renderMarkers(); } else seek(sc.start);
    };
    b.ondblclick = (e) => { e.stopPropagation(); clearSel(); E.queue = null; seek(sc.start); renderMarkers(); };
    b.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      const many = E.sel.has(i) && E.sel.size > 1 ? [...E.sel] : [i];
      if (confirm(many.length > 1 ? `Видалити ${many.length} вибраних секцій?` : `Видалити секцію «${sc.name || 'секція'}» зі структури?`)) opDeleteMany(many);
    };
    box.append(el);
  });
}
// ── Waveform ──
function computePeaks() {
  const bins = 1400, pk = new Float32Array(bins), dur = E.dur;
  if (!dur) { E.peaks = null; return; }
  for (const st of E.stems) {
    if (/click|metronome|метроном|guide|cue|гайд/i.test(st.name)) continue;
    for (const g of st.segs) {
      const ch = g.buffer.getChannelData(0), sr = g.buffer.sampleRate;
      const b0 = Math.max(0, Math.floor((g.t / dur) * bins)), b1 = Math.min(bins, Math.ceil(((g.t + g.d) / dur) * bins));
      for (let b = b0; b < b1; b++) {
        const t0 = (b / bins) * dur, t1 = ((b + 1) / bins) * dur;
        const f0 = Math.max(0, Math.floor((g.off + (t0 - g.t) * g.rate) * sr)), f1 = Math.min(ch.length, Math.floor((g.off + (t1 - g.t) * g.rate) * sr));
        const step = Math.max(1, Math.floor((f1 - f0) / 40)); let m = 0;
        for (let i = f0; i < f1; i += step) { const v = Math.abs(ch[i]); if (v > m) m = v; }
        pk[b] += m;
      }
    }
  }
  const mx = Math.max(...pk) || 1;
  E.peaks = pk.map((v) => Math.pow(v / mx, 0.65));
}
function drawWave() {
  const cv = $('#waveCv'), r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  $('#waveHint').hidden = !!E.peaks;
  const pk = E.peaks; if (!pk) return;
  const n = pk.length, mid = cv.height / 2, h = cv.height * 0.4; g.fillStyle = 'rgba(236,238,242,.85)';
  for (let x = 0; x < cv.width; x += 2 * dpr) {
    const hh = Math.max(1, pk[Math.min(n - 1, Math.floor((x / cv.width) * n))] * h);
    g.fillRect(x, mid - hh, Math.max(1, 1.4 * dpr), hh * 2);
  }
}
new ResizeObserver(drawWave).observe($('#wave'));
$('#wave').onclick = (e) => {
  if (!E.dur || e.target.closest('#selbar')) return;
  const r = e.currentTarget.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * E.dur;
  if (e.shiftKey || e.metaKey || e.ctrlKey) { const i = sectionIndexAt(t); if (i >= 0) selectSection(i, e); return; }
  if (E.sel.size) { clearSel(); return; }
  E.queue = null; seek(t); renderMarkers();
};
function markCurrentSection() {
  if (!E.song || guardLock()) return;
  const name = prompt('Назва секції (Verse, Chorus, Bridge…)', ''); if (name === null) return;
  if (S.arr[E.song.id]) return opSplit(name.trim());
  const m = S.markers[E.song.id] ||= []; m.push({ t: Math.round(position() * E.tempo * 100) / 100, name: name.trim() });
  save('markers'); rebuildMarkers();
}
function saveMix() {
  if (!E.song) return;
  S.mix[E.song.id] = Object.fromEntries(E.stems.map((s) => [key(s.name), { vol: s.vol, mute: s.mute }])); save('mix');
}
function renderReport(w) {
  const d = $('#report'); d.hidden = !w.length; $('#warn').hidden = !w.length;
  $('#report summary').textContent = `⚠ Зауваження імпорту (${w.length})`;
  const ul = $('#report ul'); ul.innerHTML = '';
  w.forEach((x) => { const li = document.createElement('li'); li.textContent = x; ul.append(li); });
}

// ── Ableton projects ──
let ablIndex = null, ablCache = null;
async function openAbleton() {
  if (!window.showDirectoryPicker) return status('Потрібен Chrome/Edge');
  const root = await showDirectoryPicker();
  status('Шукаю проєкти Ableton…');
  ablIndex = await indexFolder(root);
  ablCache = null; const mc = ablIndex.byName.get('markers-cache.json')?.[0];
  if (mc) { try { ablCache = JSON.parse(await (await mc.handle.getFile()).text()); } catch {} }
  const projects = ablIndex.projects;
  library = library.filter((s) => s.src !== 'als').concat(projects.map((p) => ({
    id: 'als:' + p.parts.join('/'), name: p.name.replace(/\.als$/i, ''), src: 'als', prefetch: async () => {},
    load: async (q) => { const r = await loadProject(p, ablIndex, E.ctx, (d, n) => { if (typeof q === 'function') q(d, n); else if (!q) status(`${p.name}: ${d}/${n} треків`); }); await applyMarkersCache(r, p); return r; },
  })));
  renderLibrary(); status(`Знайдено проєктів Ableton: ${projects.length}`);
}

// Section markers heard earlier by whisper on the Guide (team's _setlist-tools/markers-cache.json): [[seconds, "Verse 1"], ...]
async function applyMarkersCache(r, p) {
  if (!ablCache) return;
  if ((r.markers || []).filter((m) => m.name && !/^\d+$/.test(m.name)).length >= 3) return;
  const base = `${p.parts[p.parts.length - 2]}/${p.name}`, size = (await p.handle.getFile()).size;
  const hit = ablCache[`${base}|${size}`] || Object.entries(ablCache).find(([k]) => k.startsWith(base + '|'))?.[1];
  if (hit) r.markers = hit.map(([t, name]) => ({ t, name })).filter((m) => m.t <= r.dur);
}

// ── Export stems as WAV (24-bit) into a folder — e.g. a Drive-synced one ──
async function writeWav(dir, filename, ab) {
  const ch = ab.numberOfChannels, n = ab.length, dataLen = n * ch * 3;
  const h = new DataView(new ArrayBuffer(44)); const s = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); s(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
  h.setUint16(22, ch, true); h.setUint32(24, ab.sampleRate, true); h.setUint32(28, ab.sampleRate * ch * 3, true);
  h.setUint16(32, ch * 3, true); h.setUint16(34, 24, true); s(36, 'data'); h.setUint32(40, dataLen, true);
  const w = await (await dir.getFileHandle(filename, { create: true })).createWritable();
  await w.write(h);
  const data = Array.from({ length: ch }, (_, c) => ab.getChannelData(c)), CH = 96000;
  for (let i = 0; i < n; i += CH) {
    const m = Math.min(CH, n - i), buf = new Uint8Array(m * ch * 3); let o = 0;
    for (let k = 0; k < m; k++) for (let c = 0; c < ch; c++) {
      const v = Math.round(Math.max(-1, Math.min(1, data[c][i + k])) * 8388607);
      buf[o++] = v & 255; buf[o++] = (v >> 8) & 255; buf[o++] = (v >> 16) & 255;
    }
    await w.write(buf);
  }
  await w.close();
}
async function exportStems() {
  if (!E.stems.length) return status('Спершу завантажте пісню');
  if (!window.showDirectoryPicker) return status('Потрібен Chrome/Edge');
  const root = await showDirectoryPicker({ mode: 'readwrite' });
  const safe = (x) => x.replace(/[\\/:*?"<>|]/g, '_').trim();
  const dir = await root.getDirectoryHandle(safe(E.song.name), { create: true });
  let i = 0;
  for (const st of E.stems) {
    status(`Експорт ${++i}/${E.stems.length}: ${st.name}`);
    const F = fadeOf(), outDur = F ? Math.min(E.dur, F.t + F.dur) : E.dur;
    const oc = new OfflineAudioContext(st.channels, Math.ceil(outDur * 48000), 48000);
    const g = oc.createGain(); g.gain.setValueAtTime(st.vol, 0); g.connect(oc.destination);
    if (F) g.gain.setValueCurveAtTime(fadeCurve(0).map((v) => v * st.vol), F.t, F.dur);
    schedule(oc, st, g, 0, 0);
    await writeWav(dir, `${String(i).padStart(2, '0')} ${safe(st.name)}.wav`, await oc.startRendering());
  }
  status(`Експортовано ${E.stems.length} стемів у «${E.song.name}»`);
}

function selectTab(t) {
  $('#menu').hidden = true;
  const ov = $('#overlay');
  if (!t || t === 'mixer') { ov.hidden = true; return; }
  ov.hidden = false;
  document.querySelectorAll('.tab').forEach((x) => { x.hidden = x.id !== 'tab-' + t; });
  if (t === 'patch') renderMatrix();
  if (t === 'pads') renderPads();
  if (t === 'library') { renderLibrary(); renderSetlist(); }
  if (t === 'edit') { renderVersions(); renderStructure(); renderSongPad(); }
  if (t === 'remote') renderRemote();
}

async function fillDevices() {
  const sel = $('#device'); sel.innerHTML = '<option value="">Системний за замовчуванням</option>';
  try {
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
      .forEach((d, i) => sel.append(new Option(d.label || 'Пристрій ' + (i + 1), d.deviceId)));
  } catch {}
  if (S.deviceId && ![...sel.options].some((o) => o.value === S.deviceId)) sel.append(new Option('Вибраний пристрій', S.deviceId));
  sel.value = S.deviceId;
  const oc = $('#outCount'); oc.innerHTML = '';
  [0, 2, 4, 8, 16, 32, 64].forEach((n) => oc.append(new Option(n ? n : `усі (${E.maxOut})`, n))); oc.value = S.outCount;
}
async function changeAudio() {
  const was = E.playing, pos = position(); halt(); E.playing = false; E.pos = pos;
  await initAudio(); await fillDevices(); renderMatrix(); if (was) play();
}

function tick() {
  if (E.stems.length) {
    const p = position();
    $('#clock').textContent = `${String(Math.floor(p / 60)).padStart(2, '0')}:${String(Math.floor(p % 60)).padStart(2, '0')}`;
    $('#clockSub').textContent = `-${fmt(Math.max(0, E.dur - p))} / ${fmt(E.dur)}`;
    $('#playhead').style.left = (E.dur ? (p / E.dur) * 100 : 0) + '%';
    const cs = sectionAt(p), ci = cs ? E.markers.findIndex((m) => m.t === cs.start) : -1;
    document.querySelectorAll('#sections .sec').forEach((el, i) => el.classList.toggle('cur', i === ci));
    E.stems.forEach((st) => {
      if (!st.meter || !st.an) return;
      st.an.getFloatTimeDomainData(st.data);
      let pk = 0; for (const v of st.data) pk = Math.max(pk, Math.abs(v));
      st.meter.style.height = Math.min(100, pk * 100) + '%';
    });
  }
  requestAnimationFrame(tick);
}

// ───────────── Wiring ─────────────
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
$('#btnPlay').onclick = () => (E.playing ? pause() : play());
$('#btnEdit').onclick = () => selectTab('edit');
$('#btnSetlist').onclick = () => selectTab('library');
$('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
$('#btnPad').onclick = () => selectTab('pads');
$('#sidePatch').onclick = () => selectTab('patch');
$('#sidePad').onclick = () => selectTab('pads');
$('#closeSheet').onclick = () => selectTab(null);
$('#overlay').onclick = (e) => { if (e.target.id === 'overlay') selectTab(null); };
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
addEventListener('keydown', (e) => { if (e.code === 'Escape') selectTab(null); });
$('#sideMute').onclick = () => { const all = E.stems.length && E.stems.every((x) => x.mute); E.stems.forEach((x) => { x.mute = !all; applyGain(x); }); saveMix(); renderMixer(); };
$('#btnStop').onclick = stop;
$('#btnPrev').onclick = () => advance(-1);
$('#btnNext').onclick = () => advance(1);
$('#master').oninput = (e) => { E.masterVol = +e.target.value; E.master.gain.value = E.masterVol; };
$('#search').oninput = renderLibrary;
$('#btnDrive').onclick = () => connectDrive().catch((e) => status('Drive: ' + e.message));
$('#btnAbleton').onclick = () => openAbleton().catch((e) => status('Ableton: ' + e.message));
$('#btnExport').onclick = () => exportStems().catch((e) => status('Експорт: ' + e.message));
$('#btnLocal').onclick = () => openLocal().catch((e) => status(e.message));
$('#btnDemo').onclick = () => { if (!library.some((s) => s.src === 'demo')) library.unshift({ id: 'demo', name: 'Demo (тестові стеми)', src: 'demo' }); renderLibrary(); loadSong(library.find((s) => s.src === 'demo')); };
$('#patchAuto').onclick = () => patchAll((st, i) => (st.channels > 1 ? [(i * 2) % E.nOut, (i * 2 + 1) % E.nOut] : [i % E.nOut]));
$('#patchMain').onclick = () => patchAll(() => [0, 1]);
$('#patchClear').onclick = () => patchAll(() => []);
$('#device').onchange = (e) => { S.deviceId = e.target.value; save('deviceId'); changeAudio(); };
$('#outCount').onchange = (e) => { S.outCount = +e.target.value; save('outCount'); changeAudio(); };
$('#btnPickDevice').onclick = async () => {
  try { const d = await navigator.mediaDevices.selectAudioOutput(); S.deviceId = d.deviceId; save('deviceId'); await changeAudio(); } catch (e) { status(e.message); }
};
$('#clientId').value = S.clientId; $('#rootFolder').value = S.rootFolder;
$('#btnSaveDrive').onclick = () => { S.clientId = $('#clientId').value.trim(); S.rootFolder = $('#rootFolder').value.trim(); save('clientId'); save('rootFolder'); status('Збережено'); };
addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); E.playing ? pause() : play(); } });

// ── Key / tempo change (offline, SoundTouch in workers) ──
const NO_PITCH = /click|metronome|метроном|guide|cue|гайд/i;     // click & guide keep their pitch, only follow tempo
function runWorker(w, buf, semi, tempo) {
  return new Promise((res, rej) => {
    w.onmessage = (e) => {
      const ch = e.data.channels, nb = E.ctx.createBuffer(ch.length, ch[0].length, buf.sampleRate);
      ch.forEach((c, i) => nb.copyToChannel(c, i)); res(nb);
    };
    w.onerror = (e) => rej(new Error(e.message || 'worker error'));
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
    w.postMessage({ channels: chans, sampleRate: buf.sampleRate, semitones: semi, tempo }, chans.map((c) => c.buffer));
  });
}
async function transformStems(semi, tempo, stems = E.stems, progress = null) {
  const jobs = new Map();                                    // buffer -> Map(noPitch -> processed buffer)
  stems.forEach((st) => st.segs.forEach((g) => {
    const f = NO_PITCH.test(st.name); if (!jobs.has(g.buffer)) jobs.set(g.buffer, new Map()); jobs.get(g.buffer).set(f, null);
  }));
  const queue = [...jobs].flatMap(([buf, m]) => [...m.keys()].map((f) => ({ buf, f })));
  const total = queue.length; let done = 0; const t0 = performance.now();
  const N = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  await Promise.all(Array.from({ length: N }, async () => {
    const w = new Worker('stretch-worker.js?v=202611181546', { type: 'module' });
    try {
      while (queue.length) {
        const { buf, f } = queue.shift();
        jobs.get(buf).set(f, await runWorker(w, buf, f ? 0 : semi, tempo));
        ++done; if (progress) progress(done, total); else status(`Зміна тональності/темпу: ${done}/${total}`);
      }
    } finally { w.terminate(); }
  }));
  stems.forEach((st) => {
    const f = NO_PITCH.test(st.name);
    st.segs = st.segs.map((g) => ({ ...g, t: g.t / tempo, d: g.d / tempo, off: g.off / tempo, buffer: jobs.get(g.buffer).get(f) }));
  });
  if (stems === E.stems) { E.dur /= tempo; E.tempo = tempo; status(`Готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`); }
}
function syncXform() {
  const x = S.xform[current?.id] || { semi: 0, tempo: 1 };
  $('#xSemi').value = x.semi; $('#xTempo').value = Math.round(x.tempo * 100); $('#xTempoVal').textContent = Math.round(x.tempo * 100) + '%';
}
for (let i = -6; i <= 6; i++) $('#xSemi').append(new Option(i > 0 ? '+' + i : String(i), i));
$('#xSemi').value = 0;
$('#xTempo').oninput = (e) => { $('#xTempoVal').textContent = e.target.value + '%'; };
$('#xApply').onclick = () => {
  if (!current || guardLock()) return;
  if (current.src === 'click') return status('Для метронома змініть BPM у «⚙ Налаштування метронома»');
  const x = { semi: +$('#xSemi').value, tempo: +$('#xTempo').value / 100 };
  if (x.semi || x.tempo !== 1) S.xform[current.id] = x; else delete S.xform[current.id];
  save('xform'); loadSong(current, x);
};
$('#xReset').onclick = () => { if (!current || guardLock()) return; delete S.xform[current.id]; save('xform'); loadSong(current, null); };

// ── Section / trim / transport extras ──
$('#btnLoop').onclick = () => { E.loop = !E.loop; $('#btnLoop').classList.toggle('on', E.loop); };
$('#btnMark').onclick = markCurrentSection;
$('#btnDetect').onclick = () => { if (S.arr[E.song?.id] && !confirm('Структуру вже змінено вручну. Визначити заново й скинути правки?')) return; detectGuide(false); };
$('#btnSplit').onclick = () => opSplit();
$('#btnUndo').onclick = undoArr; $('#btnResetStruct').onclick = resetStructure;
$('#chkDetect').checked = S.autoDetect; $('#chkDetect').onchange = (e) => { S.autoDetect = e.target.checked; save('autoDetect'); };
addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); undoArr(); } });
function nextSection() {
  const s = sections(); if (!s.length) return;
  const i = s.findIndex((x) => x === sectionAt(position())); const nx = s[i + 1];
  if (!nx) return; if (E.playing) { E.queue = nx.start; renderMarkers(); } else seek(nx.start);
}
const setTrim = (patch) => { if (!E.song || guardLock()) return; S.trim[E.song.id] = { ...trimOf(), ...patch }; save('trim'); showTrim(); };
function showTrim() { const t = trimOf(); $('#trimInfo').textContent = t.start || t.end ? `обрізка: ${fmt(startPos())}–${fmt(endPos())}` : ''; }
$('#btnStartHere').onclick = () => setTrim({ start: Math.round(position() * E.tempo * 100) / 100 });
$('#btnEndHere').onclick = () => setTrim({ end: Math.round(position() * E.tempo * 100) / 100 });
$('#btnClearTrim').onclick = () => { if (E.song) { delete S.trim[E.song.id]; save('trim'); showTrim(); } };
$('#chkPre').checked = S.preload; $('#chkPre').onchange = (e) => { S.preload = e.target.checked; save('preload'); preloadNext(); };
$('#chkAuto').checked = S.autoAdvance; $('#chkAuto').onchange = (e) => { S.autoAdvance = e.target.checked; save('autoAdvance'); };
$('#btnFade').onclick = () => fadeOutStop(3);

// ── Routing presets + smart routing ──
function renderPresets(sel) {
  const el = $('#presetSel'); el.innerHTML = '<option value="">— пресет —</option>';
  Object.keys(S.presets).forEach((n) => el.append(new Option(n, n))); if (sel) el.value = sel;
}
$('#presetSave').onclick = () => {
  const n = prompt('Назва пресету (наприклад «Основний зал», «IEM»)', $('#presetSel').value || ''); if (!n) return;
  S.presets[n] = JSON.parse(JSON.stringify(S.patch)); save('presets'); renderPresets(n);
};
$('#presetLoad').onclick = () => {
  const p = S.presets[$('#presetSel').value]; if (!p) return;
  S.patch = JSON.parse(JSON.stringify(p)); save('patch'); E.stems.forEach(applyRoutes); renderMatrix(); renderMixer();
};
$('#presetDel').onclick = () => { const n = $('#presetSel').value; if (n && confirm(`Видалити пресет «${n}»?`)) { delete S.presets[n]; save('presets'); renderPresets(); } };
$('#patchSmart').onclick = () => {
  if (E.nOut < 4) status('Для Smart-патчу потрібно ≥4 виходи (Click → 3, Guide → 4, решта → 1–2)');
  patchAll((st) => (E.nOut >= 4 && /click|metronome|метроном/i.test(st.name) ? [2] : E.nOut >= 4 && /guide|cue|гайд/i.test(st.name) ? [3] : [0, 1]));
};
renderPresets();

// ── Ambient pads (synth, independent of the song, own outputs) ──
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const P = { ctx: null, bus: null, split: null, voice: null };
function padEnsure() {
  if (P.ctx === E.ctx && P.bus) return;
  P.ctx = E.ctx; P.voice = null;
  P.bus = E.ctx.createGain(); Object.assign(P.bus, { channelCount: 2, channelCountMode: 'explicit' });
  P.split = E.ctx.createChannelSplitter(2); P.bus.connect(P.split); padRoute(); P.bus.gain.value = S.pad.vol;
}
function padRoute() {
  if (!P.split) return; P.split.disconnect();
  S.pad.out.forEach((o, i) => { if (o != null && o >= 0 && o < E.nOut) P.split.connect(E.merger, i, o); });
}
function padStop(fade = 3) {
  const v = P.voice; if (!v) return; P.voice = null;
  const t = E.ctx.currentTime; v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + fade);
  v.oscs.forEach((o) => o.stop(t + fade + 0.1)); setTimeout(() => v.g.disconnect(), (fade + 0.3) * 1000);
}
function padStart(k, fade = 3) {
  padEnsure(); E.ctx.resume();
  if (P.voice?.key === k) { padStop(fade); renderPads(); return; }
  padStop(fade);
  const ctx = E.ctx, f = 130.81 * 2 ** (KEYS.indexOf(k) / 12);
  const g = ctx.createGain(); g.gain.value = 0; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300; g.connect(lp); lp.connect(P.bus);
  const oscs = [];
  [[f / 2, 0], [f, -0.6], [f * 1.5, 0.6], [f * 2, -0.3], [f * 3, 0.4]].forEach(([fr, pan], i) => [-7, 7].forEach((det, j) => {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = fr; o.detune.value = det;
    const p = ctx.createStereoPanner(); p.pan.value = pan * (j ? -1 : 1); const og = ctx.createGain(); og.gain.value = 0.1 / (1 + i * 0.3);
    o.connect(og); og.connect(p); p.connect(g); o.start(); oscs.push(o);
  }));
  const t = ctx.currentTime; g.gain.linearRampToValueAtTime(1, t + fade);
  P.voice = { key: k, g, oscs }; renderPads();
}
function renderPads() {
  const box = $('#padKeys'); box.innerHTML = '';
  KEYS.forEach((k) => { const b = document.createElement('button'); b.textContent = k; b.classList.toggle('on', P.voice?.key === k); b.onclick = () => padStart(k); box.append(b); });
  ['padL', 'padR'].forEach((id, i) => {
    const s = $('#' + id); s.innerHTML = '<option value="-1">—</option>';
    for (let c = 0; c < E.nOut; c++) s.append(new Option(`${c + 1}${S.outNames[c] ? ' ' + S.outNames[c] : ''}`, c));
    s.value = S.pad.out[i] ?? -1; s.onchange = () => { S.pad.out[i] = +s.value; save('pad'); padRoute(); };
  });
  $('#padVol').value = S.pad.vol;
}
$('#padVol').oninput = (e) => { S.pad.vol = +e.target.value; save('pad'); if (P.bus) P.bus.gain.value = S.pad.vol; };
$('#padStop').onclick = () => { padStop(3); renderPads(); };

// ── MIDI remote (Web MIDI notes) ──
const MIDI_MAP = { 60: () => (E.playing ? pause() : play()), 61: () => stop(), 62: () => advance(1), 63: () => advance(-1), 64: nextSection, 65: () => $('#btnLoop').click(), 66: () => fadeOutStop(3) };
function midiMsg(e) { const [s, n, v] = e.data; if ((s & 0xf0) === 0x90 && v) MIDI_MAP[n]?.(); }
$('#btnMidi').onclick = async () => {
  if (!navigator.requestMIDIAccess) return ($('#midiInfo').textContent = 'Web MIDI недоступний в цьому браузері');
  try {
    const a = await navigator.requestMIDIAccess();
    const hook = () => { const ins = [...a.inputs.values()]; ins.forEach((i) => (i.onmidimessage = midiMsg)); $('#midiInfo').textContent = ins.length ? 'MIDI входи: ' + ins.map((i) => i.name).join(', ') : 'MIDI-пристроїв не знайдено'; };
    hook(); a.onstatechange = hook;
  } catch (e) { $('#midiInfo').textContent = 'MIDI: ' + e.message; }
};

addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'ArrowRight') nextSection();
  if (e.code === 'ArrowLeft') seek(startPos());
});

offlineDrive(); renderLibrary(); renderSetlist();
await initAudio(); await fillDevices(); tick();
status(`Вихід: ${E.nOut} кан.`);

// ── Phone remote (host) ──
function remoteState() {
  const p = position(), cs = sectionAt(p), ci = cs ? E.markers.findIndex((m) => m.t === cs.start) : -1, F = fadeOf(), r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  return {
    song: E.song?.name || '', playing: E.playing, pos: r1(p), dur: r1(E.dur), end: r1(endPos()), bpm: E.bpm || 0, loop: !!E.loop, queue: E.queue, cur: ci,
    sections: sections().map((x) => { const i = secInfo(x.name); return { n: x.name, a: r2(x.start), b: r2(x.end), c: i.color, code: i.code }; }),
    setlist: S.setlist.map((id) => library.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name, cur: x === current })),
    stems: E.stems.map((st) => ({ n: st.name, v: st.vol, m: st.mute, s: st.solo })), master: E.masterVol, padKey: P.voice?.key || null,
    fade: F ? { t: r1(F.t), dur: r1(F.dur) } : null, locked: locked(), status: ($('#status').textContent || '').slice(0, 120),
  };
}
function remoteExec(c, a) {
  switch (c) {
    case 'toggle': E.playing ? pause() : play(); break;
    case 'stop': stop(); break;
    case 'next': advance(1); break;
    case 'prev': advance(-1); break;
    case 'nextSection': nextSection(); break;
    case 'queue': if (E.playing) { E.queue = a.t; renderMarkers(); } else seek(a.t); break;
    case 'jump': E.queue = null; seek(a.t); renderMarkers(); break;
    case 'loop': $('#btnLoop').click(); break;
    case 'fade': fadeOutStop(a.s || 3); break;
    case 'load': { const sg = library.find((x) => x.id === a.id); if (sg) loadSong(sg); break; }
    case 'master': E.masterVol = Math.max(0, Math.min(1.5, +a.v)); E.master.gain.value = E.masterVol; $('#master').value = E.masterVol; break;
    case 'vol': { const st = E.stems[a.i]; if (st) { st.vol = Math.max(0, Math.min(1.5, +a.v)); if (st.fEl) st.fEl.value = st.vol; applyGain(st); saveMix(); } break; }
    case 'mute': E.stems[a.i]?.mEl?.click(); break;
    case 'solo': E.stems[a.i]?.sEl?.click(); break;
    case 'muteAll': $('#sideMute').click(); break;
    case 'pad': padStart(a.k); break;
    case 'padStop': padStop(3); renderPads(); break;
  }
}
let REMOTE = null;
const remoteUrl = () => new URL(`remote.html#${S.remote.id}.${S.remote.pin}`, location.href).href;
async function remoteApply() {
  const R = S.remote; if (REMOTE) { REMOTE.stop(); REMOTE = null; }
  if (R.on) {
    if (!R.id) { R.id = 'ubcpb-' + Math.random().toString(36).slice(2, 10); R.pin = String(Math.floor(1000 + Math.random() * 9000)); }
    save('remote'); R.status = { signalling: 'connecting', clients: 0 };
    try { REMOTE = await startHost({ id: R.id, pin: R.pin, getState: remoteState, exec: remoteExec, onStatus: (st) => { R.status = st; renderRemote(); } }); }
    catch (e) { R.status = { error: e.message }; }
  } else save('remote');
  renderRemote();
}
async function renderRemote() {
  const R = S.remote; if (!$('#remoteOn')) return;
  $('#remoteOn').checked = !!R.on; $('#remoteBox').hidden = !R.on;
  if (!R.on || !R.id) return;
  $('#remoteUrl').value = remoteUrl(); $('#remotePin').textContent = R.pin; $('#remoteCode').textContent = R.id;
  try { await loadScript('vendor/qrcode.js'); const qr = window.qrcode(0, 'M'); qr.addData(remoteUrl()); qr.make(); $('#remoteQr').innerHTML = qr.createSvgTag(5, 2); } catch {}
  const st = R.status || {};
  $('#remoteInfo').textContent = st.error ? (st.error === 'unavailable-id' ? 'Цей код уже використовується (апка відкрита в іншій вкладці?) — натисніть «Новий код»' : /network|server|socket|browser/.test(st.error) ? 'Немає зв’язку із сигнальним сервером (потрібен інтернет)' : 'Помилка: ' + st.error)
    : st.signalling === 'open' ? `● Готово до підключення · підключено пристроїв: ${st.clients || 0}` : 'З’єднуюсь із сигнальним сервером…';
}
$('#remoteOn').onchange = (e) => { S.remote.on = e.target.checked; remoteApply(); };
$('#remoteNew').onclick = () => { S.remote.id = null; S.remote.pin = null; remoteApply(); };
$('#remoteCopy').onclick = async () => { try { await navigator.clipboard.writeText(remoteUrl()); status('Посилання скопійовано'); } catch { $('#remoteUrl').select(); } };
if (S.remote.on) remoteApply();

// ── Songs without a playback: metronome (click) + pad, saved under the song's name ──
const SIGS = { '4/4': { bpb: 4, comp: false }, '3/4': { bpb: 3, comp: false }, '2/4': { bpb: 2, comp: false }, '5/4': { bpb: 5, comp: false }, '6/8': { bpb: 2, comp: true }, '12/8': { bpb: 4, comp: true } };
function makeBarBuffer(def) {                      // one bar of click: accent on 1, softer beats, quiet subdivisions
  const sr = 48000, { bpb, comp } = SIGS[def.sig] || SIGS['4/4'], beat = 60 / def.bpm;
  const sub = def.sub === '8th' ? (comp ? 3 : 2) : def.sub === '16th' ? (comp ? 6 : 4) : 1;
  const n = Math.round(bpb * beat * sr), buf = E.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const tick = (t, f, a) => { const i0 = Math.round(t * sr), len = Math.floor(0.05 * sr); for (let k = 0; k < len && i0 + k < n; k++) { const x = k / sr; d[i0 + k] += a * (Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 85) + 0.3 * Math.sin(2 * Math.PI * f * 2.76 * x) * Math.exp(-x * 150)); } };
  for (let b = 0; b < bpb; b++) { tick(b * beat, b === 0 ? 1760 : 1175, b === 0 ? 0.85 : 0.55); for (let k = 1; k < sub; k++) tick(b * beat + (k * beat) / sub, 880, 0.2); }
  return buf;
}
function buildClickSong(def) {
  const buf = makeBarBuffer(def), bars = Math.max(4, def.bars || 100), barDur = buf.duration;
  const segs = Array.from({ length: bars }, (_, i) => ({ t: i * barDur, d: barDur, off: 0, rate: 1, buffer: buf, cutIn: false, cutOut: false }));
  return { stems: [{ name: 'Click', channels: 1, segs, vol: 1 }], dur: bars * barDur, tempo: def.bpm, markers: [], warnings: [] };
}
const clickEntry = (def) => ({ id: def.id, name: def.name, src: 'click', def, prefetch: async () => {}, load: async () => buildClickSong(def) });
function syncClickLibrary() {
  library = library.filter((x) => x.src !== 'click').concat(Object.values(S.clicks).map(clickEntry));
  renderLibrary(); renderSetlist();
}
const slug = (n) => n.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'song';
const NS = { editId: null, taps: [] };
function openNewSong(def) {
  NS.editId = def?.id || null; NS.taps = [];
  $('#nsTitle').textContent = def ? 'Налаштування метронома' : 'Нова пісня без плейбеку';
  $('#nsName').value = def?.name || ''; $('#nsBpm').value = def?.bpm || 72; $('#nsSig').value = def?.sig || '4/4'; $('#nsSub').value = def?.sub || 'none';
  $('#nsBars').value = def?.bars || 100; const sp = S.songPad[def?.id] || {}; $('#nsKey').value = sp.key || ''; $('#nsAuto').checked = def ? !!sp.auto : true;
  $('#nsDelete').hidden = !def; $('#nsName').disabled = false;
  selectTab('newsong');
}
function saveNewSong() {
  const name = $('#nsName').value.trim(), bpm = +$('#nsBpm').value;
  if (!name) return status('Вкажіть назву пісні'); if (!(bpm >= 30 && bpm <= 300)) return status('BPM має бути від 30 до 300');
  let id = NS.editId;
  if (!id) { id = 'click:' + slug(name); let k = 2; while (S.clicks[id]) id = 'click:' + slug(name) + '-' + k++; }
  S.clicks[id] = { id, name, bpm: Math.round(bpm * 10) / 10, sig: $('#nsSig').value, sub: $('#nsSub').value, bars: Math.max(4, Math.min(600, +$('#nsBars').value || 100)), updated: Date.now() }; save('clicks');
  const key = $('#nsKey').value; if (key) S.songPad[id] = { key, auto: $('#nsAuto').checked }; else delete S.songPad[id]; save('songPad');
  syncClickLibrary();
  if (!S.setlist.includes(id)) { S.setlist.push(id); save('setlist'); }
  selectTab(null); const entry = library.find((x) => x.id === id); renderSetlist(); loadSong(entry); status(`Збережено «${name}» (${S.clicks[id].bpm} BPM, ${S.clicks[id].sig})`);
}
$('#btnNewSong').onclick = () => openNewSong(null);
$('#btnClickSettings').onclick = () => { if (current?.src === 'click') openNewSong(S.clicks[current.id]); else status('Це не метроном-пісня'); };
$('#nsSave').onclick = saveNewSong; $('#nsCancel').onclick = () => selectTab(null);
$('#nsDelete').onclick = () => {
  const id = NS.editId; if (!id || !confirm(`Видалити «${S.clicks[id].name}» назавжди (проєкт, секції, версії)?`)) return;
  [S.clicks, S.songPad, S.arr, S.markers, S.mix, S.xform, S.trans, S.trim, S.fade, S.ver, S.pinned].forEach((o) => delete o[id]);
  ['clicks', 'songPad', 'arr', 'markers', 'mix', 'xform', 'trans', 'trim', 'fade', 'ver', 'pinned'].forEach(save);
  S.setlist = S.setlist.filter((x) => x !== id); save('setlist'); stop(); current = null; E.stems = []; E.song = null; E.dur = 0;
  syncClickLibrary(); renderMixer(); renderMarkers(); drawWave(); selectTab(null); status('Пісню видалено');
};
$('#nsTap').onclick = () => {
  const n = performance.now(); if (NS.taps.length && n - NS.taps[NS.taps.length - 1] > 2000) NS.taps = [];
  NS.taps.push(n); if (NS.taps.length > 8) NS.taps.shift();
  if (NS.taps.length >= 2) { const iv = (NS.taps[NS.taps.length - 1] - NS.taps[0]) / (NS.taps.length - 1); $('#nsBpm').value = Math.round((60000 / iv) * 10) / 10; }
};
KEYS.forEach((k) => $('#nsKey').append(new Option(k, k)));
// pad per song (for any song, with or without playback)
KEYS.forEach((k) => $('#songPadKey').append(new Option(k, k)));
function renderSongPad() { const sp = S.songPad[E.song?.id] || {}; $('#songPadKey').value = sp.key || ''; $('#songPadAuto').checked = !!sp.auto; $('#btnClickSettings').hidden = E.song?.src !== 'click'; }
const saveSongPad = () => {
  if (!E.song || guardLock()) return; const key = $('#songPadKey').value;
  if (key) S.songPad[E.song.id] = { key, auto: $('#songPadAuto').checked }; else delete S.songPad[E.song.id]; save('songPad');
};
$('#songPadKey').onchange = saveSongPad; $('#songPadAuto').onchange = saveSongPad;
$('#songPadNow').onclick = () => { const k = $('#songPadKey').value; if (k) padStart(k); };
syncClickLibrary();

// ───────────── Home page: Sundays, setlist builder, preflight (loading menu) ─────────────
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nextSundayISO = () => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return isoLocal(d); };
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const activeSunday = () => S.sundays.find((x) => x.id === S.activeSunday) || null;
function syncSunday() { const sun = activeSunday(); if (sun) { sun.list = [...S.setlist]; sun.updated = Date.now(); store.set('sundays', S.sundays); } }
function ensureSunday() {
  if (!S.sundays.length) { const date = nextSundayISO(); S.sundays.push({ id: 'sun-' + Date.now(), name: 'Неділя ' + fmtDate(date), date, list: [...S.setlist], updated: Date.now() }); S.activeSunday = S.sundays[0].id; }
  if (!activeSunday()) S.activeSunday = S.sundays[0].id;
  S.setlist = [...activeSunday().list]; store.set('sundays', S.sundays); store.set('activeSunday', S.activeSunday); store.set('setlist', S.setlist);
}
function setActiveSunday(id) {
  const sun = S.sundays.find((x) => x.id === id); if (!sun) return;
  S.activeSunday = id; store.set('activeSunday', id); S.setlist = [...sun.list]; store.set('setlist', S.setlist); renderSetlist(); renderHome();
}
function showScreen(name) { $('#home').hidden = name !== 'home'; $('#preflight').hidden = name !== 'preflight'; if (name === 'home') renderHome(); }

function renderLibInfo() {
  const c = (src) => library.filter((x) => x.src === src).length, p = [];
  if (c('drive')) p.push(`Google Drive: ${c('drive')} пісень${hasToken() ? ' · ви ввійшли' : ' · вхід у Google буде запитано під час підготовки'}`); if (c('local')) p.push(`Папка: ${c('local')}`); if (c('als')) p.push(`Ableton: ${c('als')}`); if (c('click')) p.push(`без плейбеку: ${c('click')}`);
  $('#hLibInfo').textContent = p.length ? p.join(' · ') : 'Бібліотека порожня — підключіть Google Drive або оберіть папку з плейбеками.';
  $('#hDrive').classList.toggle('on', !!c('drive'));
}
function renderSundays() {
  const box = $('#sundayList'); box.innerHTML = '';
  S.sundays.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach((sun) => {
    const el = document.createElement('div'); el.className = 'sun' + (sun.id === S.activeSunday ? ' cur' : '');
    el.innerHTML = '<b></b><small></small><div class="acts"><button class="go" title="Підготувати й запустити">▶</button><button class="ren" title="Перейменувати">✎</button><button class="dup" title="Дублювати">⧉</button><button class="del" title="Видалити">✕</button></div>';
    $('b', el).textContent = sun.name; $('small', el).textContent = `${fmtDate(sun.date)} · ${sun.list.length} пісень`;
    el.onclick = () => setActiveSunday(sun.id);
    $('.go', el).onclick = (e) => { e.stopPropagation(); setActiveSunday(sun.id); startPreflight(); };
    $('.ren', el).onclick = (e) => { e.stopPropagation(); const n = prompt('Назва неділі:', sun.name); if (n) { sun.name = n.trim(); sun.updated = Date.now(); store.set('sundays', S.sundays); renderHome(); } };
    $('.dup', el).onclick = (e) => { e.stopPropagation(); const c = { ...sun, id: 'sun-' + Date.now(), name: sun.name + ' (копія)', list: [...sun.list], updated: Date.now() }; S.sundays.push(c); store.set('sundays', S.sundays); setActiveSunday(c.id); };
    $('.del', el).onclick = (e) => { e.stopPropagation(); if (S.sundays.length <= 1) return status('Має лишитись хоча б одна неділя'); if (!confirm(`Видалити «${sun.name}»?`)) return; S.sundays = S.sundays.filter((x) => x.id !== sun.id); store.set('sundays', S.sundays); if (S.activeSunday === sun.id) setActiveSunday(S.sundays[0].id); else renderHome(); };
    box.append(el);
  });
}
function renderBuilder() {
  const sun = activeSunday(); $('#bTitle').textContent = sun ? `«${sun.name}» · ${fmtDate(sun.date)}` : '';
  const q = $('#bSearch').value.toLowerCase(), inSet = new Set(S.setlist);
  const lib = $('#bLib'); lib.innerHTML = '';
  library.filter((x) => x.src !== 'demo' && x.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'uk')).slice(0, 400).forEach((x) => {
    const li = document.createElement('li'); li.innerHTML = '<span></span><small></small><button>＋</button>';
    $('span', li).textContent = x.name; $('small', li).textContent = { drive: 'Drive', als: 'Ableton', local: 'папка', click: '♩ без плейбеку' }[x.src] || '';
    if (inSet.has(x.id)) li.classList.add('cur');
    li.onclick = () => { if (!S.setlist.includes(x.id)) { S.setlist.push(x.id); save('setlist'); renderSetlist(); renderHome(); } };
    lib.append(li);
  });
  if (!lib.children.length) lib.innerHTML = '<li class="hint" style="cursor:default">Нічого не знайдено. Підключіть бібліотеку вище.</li>';
  const set = $('#bSet'); set.innerHTML = '';
  S.setlist.forEach((id, i) => {
    const x = library.find((y) => y.id === id), li = document.createElement('li');
    li.innerHTML = `<small>${i + 1}</small><span></span><small class="bd"></small><button class="up">▲</button><button class="dn">▼</button><button class="rm">✕</button>`;
    $('span', li).textContent = x ? x.name : '⚠ немає в бібліотеці';
    $('.bd', li).textContent = [!x ? 'підключіть джерело' : '', S.pinned[id] ? '🔒' : '', S.ver[id] ? '★' : '', S.xform[id] ? 'тон/темп' : '', x?.src === 'click' ? '♩' : ''].filter(Boolean).join(' ');
    const mv = (d) => (e) => { e.stopPropagation(); const j = i + d; if (j < 0 || j >= S.setlist.length) return; [S.setlist[i], S.setlist[j]] = [S.setlist[j], S.setlist[i]]; save('setlist'); renderSetlist(); renderHome(); };
    $('.up', li).onclick = mv(-1); $('.dn', li).onclick = mv(1);
    $('.rm', li).onclick = (e) => { e.stopPropagation(); S.setlist.splice(i, 1); save('setlist'); renderSetlist(); renderHome(); };
    set.append(li);
  });
  if (!S.setlist.length) set.innerHTML = '<li class="hint" style="cursor:default">Сетліст порожній — натискайте пісні ліворуч.</li>';
  $('#hLaunch').disabled = !S.setlist.length;
  $('#hLaunchInfo').textContent = S.setlist.length ? `${S.setlist.length} пісень: завантажаться файли, гайди й секції, щоб переходи були швидкими` : 'Додайте хоча б одну пісню';
}
function renderHome() { if ($('#home').hidden) return; $('#hContinue').hidden = !E.stems.length; renderLibInfo(); renderSundays(); renderBuilder(); }
$('#hDrive').onclick = () => connectDrive().then(renderHome).catch((e) => status('Drive: ' + e.message));
$('#hLocal').onclick = () => openLocal().then(renderHome).catch((e) => status(e.message));
$('#hAbleton').onclick = () => openAbleton().then(renderHome).catch((e) => status('Ableton: ' + e.message));
$('#hNew').onclick = () => openNewSong(null);
$('#hDemo').onclick = () => { if (!library.some((x) => x.src === 'demo')) library.unshift({ id: 'demo', name: 'Demo (тестові стеми)', src: 'demo' }); if (!S.setlist.includes('demo')) { S.setlist.push('demo'); save('setlist'); renderSetlist(); } renderHome(); };
$('#hSettings').onclick = () => selectTab('settings');
$('#bSearch').oninput = renderBuilder;
$('#hNewSunday').onclick = () => { $('#newSunday').hidden = false; const d = nextSundayISO(); $('#nsuDate').value = d; $('#nsuName').value = 'Неділя ' + fmtDate(d); $('#nsuName').focus(); };
$('#nsuCancel').onclick = () => { $('#newSunday').hidden = true; };
$('#nsuDate').onchange = () => { if (/^Неділя \d/.test($('#nsuName').value)) $('#nsuName').value = 'Неділя ' + fmtDate($('#nsuDate').value); };
$('#nsuCreate').onclick = () => {
  const name = $('#nsuName').value.trim() || 'Неділя', date = $('#nsuDate').value || nextSundayISO();
  const sun = { id: 'sun-' + Date.now(), name, date, list: $('#nsuCopy').checked ? [...S.setlist] : [], updated: Date.now() };
  S.sundays.push(sun); store.set('sundays', S.sundays); $('#newSunday').hidden = true; setActiveSunday(sun.id);
};
$('#btnHome').onclick = () => { if (E.playing && !confirm('Зараз грає плейбек. Піти на домашню сторінку? (відтворення продовжиться)')) return; showScreen('home'); };
$('#hContinue').onclick = () => { if (E.stems.length) showScreen(null); else startPreflight(); };

// ── Preflight: downloads files, decodes, listens to the Guide for sections, pre-computes key/tempo ──
const PF = { cancel: false, running: false, rows: [], t0: 0 };
const STAGES = [['files', 'Файли'], ['decode', 'Розпаковка'], ['sections', 'Guide → секції'], ['tone', 'Тон/темп']];
const stemsOf = (items) => (Array.isArray(items) ? items : items.stems);
const bytesOf = (items) => { const seen = new Set(); let b = 0; for (const st of stemsOf(items)) for (const g of st.segs || []) if (!seen.has(g.buffer)) { seen.add(g.buffer); b += g.buffer.length * g.buffer.numberOfChannels * 4; } return b; };
function pfBuild(songs) {
  const box = $('#pfRows'); box.innerHTML = ''; PF.rows = [];
  songs.forEach((sg, i) => {
    const el = document.createElement('div'); el.className = 'pfrow';
    el.innerHTML = `<div class="pfn"><span class="ix">${i + 1}</span><b></b><small class="mb"></small></div><div class="stages">${STAGES.map(([k, t]) => `<div class="stg" data-k="${k}"><span>${t}</span><div class="bar"><i></i></div></div>`).join('')}</div><div class="pfmsg"></div>`;
    $('b', el).textContent = sg ? sg.name : S.setlist[i]; if (!sg) el.classList.add('bad');
    box.append(el); PF.rows.push({ el, st: {}, skip: new Set(), done: false, err: false });
  });
}
function setStage(i, k, d, t) {
  const r = PF.rows[i]; if (!r) return; r.st[k] = t ? Math.min(1, d / t) : 1; r.skip.delete(k);
  const stg = $(`.stg[data-k="${k}"]`, r.el); stg.classList.remove('skip'); $('i', stg).style.width = r.st[k] * 100 + '%'; stg.classList.toggle('done', r.st[k] >= 1); pfOverall();
}
function skipStage(i, k) { const r = PF.rows[i]; if (!r) return; r.skip.add(k); delete r.st[k]; $(`.stg[data-k="${k}"]`, r.el).classList.add('skip'); }
function pfMsg(i, text, cls) { const r = PF.rows[i]; $('.pfmsg', r.el).textContent = text; r.el.classList.toggle('bad', cls === 'bad'); r.el.classList.toggle('ok', cls === 'ok'); }
function pfOverall() {
  if (!PF.rows.length) return; let sum = 0;
  PF.rows.forEach((r) => { if (r.done) { sum += 1; return; } const ks = STAGES.map((x) => x[0]).filter((k) => !r.skip.has(k)); sum += ks.length ? ks.reduce((a, k) => a + (r.st[k] || 0), 0) / ks.length : 0; });
  $('#pfBar').style.width = (sum / PF.rows.length) * 100 + '%'; $('#pfPct').textContent = Math.round((sum / PF.rows.length) * 100) + '%';
}
const sectionsKnown = (sg, items) => !!(S.markers[sg.id]?.length || S.arr[sg.id] || pinnedVersion(sg.id) || (items && !Array.isArray(items) && (items.markers || []).filter((m) => m.name && !/^\d+$/.test(m.name)).length >= 3));
async function pfDetect(i, sg, guideSegs, dur) {
  setStage(i, 'sections', 0, 1); pfMsg(i, 'Слухаю Guide…');
  await asrInit(); const x = guideSamplesFrom(guideSegs, dur);
  const res = await detectSections(x, 16000, asrText, (d, t) => setStage(i, 'sections', d, t));
  if (res.length) { const mine = (S.markers[sg.id] || []).filter((m) => !m.auto); S.markers[sg.id] = [...mine, ...res.map((r) => ({ t: Math.round(r.t * 100) / 100, name: r.name, auto: true }))]; save('markers'); }
  setStage(i, 'sections', 1, 1); return res.length;
}
async function pfPrepare(i, sg, mode) {
  if (sg.src === 'demo') { STAGES.forEach(([k]) => skipStage(i, k)); PF.rows[i].done = true; pfMsg(i, 'тестова пісня', 'ok'); return 0; }
  const keepFull = mode === 'full' || i < 2, notes = [];
  const xf = pinnedVersion(sg.id)?.xform ?? S.xform[sg.id], hasX = !!(xf && (xf.semi || xf.tempo !== 1)) && sg.src !== 'click';
  let items = null, mb = 0;
  if (keepFull) {
    setStage(i, 'decode', 0, 1); pfMsg(i, 'Розпаковую звук…');
    items = await getItems(sg, (d, t) => setStage(i, 'decode', d, t)); setStage(i, 'decode', 1, 1); mb = bytesOf(items) / 1048576;
  } else skipStage(i, 'decode');
  // sections
  const auto = S.autoDetect && !['demo', 'click'].includes(sg.src);
  if (auto && !sectionsKnown(sg, items)) {
    let guideSegs = null, dur = 0;
    if (items) { const g = stemsOf(items).find((x) => GUIDE_RE.test(x.name)); if (g) { guideSegs = g.segs; dur = Math.max(...stemsOf(items).flatMap((x) => x.segs.map((q) => q.t + q.d))); } }
    else if (sg.loadGuide) { const gi = await sg.loadGuide(() => {}); if (gi.length) { guideSegs = gi[0].segs; dur = guideSegs.reduce((m, q) => Math.max(m, q.t + q.d), 0); } }
    if (guideSegs) { const n = await pfDetect(i, sg, guideSegs, dur); notes.push(n ? `секцій: ${n}` : 'у Guide не знайдено підказок'); }
    else { skipStage(i, 'sections'); notes.push('немає стему Guide'); }
  } else { skipStage(i, 'sections'); const m = (S.markers[sg.id]?.length || 0) + (items && !Array.isArray(items) ? (items.markers || []).length : 0); if (m) notes.push(`секцій: ${m}`); }
  // key / tempo
  if (hasX && keepFull) {
    const key = JSON.stringify(xf);
    if (XC.get(sg.id)?.key !== key) {
      setStage(i, 'tone', 0, 1); pfMsg(i, 'Змінюю тональність/темп…');
      const tmp = stemsOf(items).map((it) => ({ name: it.name, segs: it.segs || [{ t: 0, d: it.buffer.duration, off: 0, rate: 1, buffer: it.buffer }] }));
      const dur0 = (!Array.isArray(items) && items.dur) || Math.max(...tmp.flatMap((st) => st.segs.map((q) => q.t + q.d)));
      await transformStems(xf.semi, xf.tempo, tmp, (d, t) => setStage(i, 'tone', d, t));
      XC.set(sg.id, { key, segs: tmp.map((x) => x.segs), dur: dur0 / xf.tempo });
    }
    setStage(i, 'tone', 1, 1);
  } else skipStage(i, 'tone');
  const r = PF.rows[i]; r.done = true;
  pfMsg(i, [keepFull ? `у пам'яті ~${Math.round(mb)} МБ` : 'файли в кеші (розпакується перед піснею)', ...notes].join(' · '), 'ok'); pfOverall();
  return mb;
}
async function startPreflight() {
  if (PF.running) return; if (!S.setlist.length) return;
  const needSignIn = S.setlist.some((id) => { const x = library.find((y) => y.id === id); return x?.src === 'drive' && !S.index[x.id]?.length; });
  let signInErr = '';
  if (needSignIn && !hasToken()) { try { await getToken(); } catch (e) { signInErr = e.message; } }   // runs inside the click: the Google popup is allowed
  showScreen('preflight'); PF.cancel = false; PF.running = true; PF.t0 = performance.now();
  const songs = S.setlist.map((id) => library.find((x) => x.id === id) || null);
  const sun = activeSunday(); $('#pfTitle').textContent = `Підготовка: ${sun ? sun.name : 'сетліст'}`; $('#pfMem').value = S.memMode;
  $('#pfEnter').disabled = true; $('#pfRetry').hidden = true; $('#pfNote').textContent = ''; $('#pfSummary').textContent = ''; $('#pfSpeed').textContent = '';
  pfBuild(songs); pfOverall();
  if (signInErr) $('#pfNote').textContent = 'Вхід у Google не вдався (' + signInErr + '). Натисніть «Google Drive» на головній і повторіть.';
  const mode = S.memMode;
  const filesReady = songs.map(() => { let r; const p = new Promise((res) => (r = res)); p.fin = r; return p; });
  let nextDl = 0;
  const mbs = (n) => Math.round(n / 104857.6) / 10;
  const dlWorker = async () => {            // two songs download at once, ahead of the decoder
    for (;;) {
      const i = nextDl++; if (i >= songs.length) return;
      const sg = songs[i];
      if (PF.cancel) { filesReady[i].fin({ ok: false, err: 'скасовано' }); continue; }
      if (!sg) { filesReady[i].fin({ ok: false, err: 'пісні немає в бібліотеці — підключіть Drive / відкрийте папку Ableton на головній' }); continue; }
      try {
        if (sg.prefetch && sg.src === 'drive') {
          setStage(i, 'files', 0, 1); pfMsg(i, 'Завантажую файли…');
          await sg.prefetch((d, t, info) => { setStage(i, 'files', d, t); if (info?.total) pfMsg(i, `Завантажую: ${mbs(info.bytes)} з ${mbs(info.total)} МБ`); });
          setStage(i, 'files', 1, 1);
        } else skipStage(i, 'files');
        filesReady[i].fin({ ok: true });
      } catch (e) { filesReady[i].fin({ ok: false, err: 'файли: ' + e.message + (/token|auth|popup|Drive 40/.test(e.message) ? ' — натисніть «Google Drive» на головній' : '') }); }
    }
  };
  PF.b0 = NET.bytes; clearInterval(PF.speedTimer);
  PF.speedTimer = setInterval(() => { const dt = (performance.now() - PF.t0) / 1000, db = NET.bytes - PF.b0; $('#pfSpeed').textContent = db > 0 ? `Завантажено з Drive: ${mbs(db)} МБ · ≈ ${(db / 1048576 / Math.max(dt, 1)).toFixed(1)} МБ/с` : ''; }, 1000);
  Promise.all([dlWorker(), dlWorker()]);
  let errs = 0, totalMB = 0;
  for (let i = 0; i < songs.length; i++) {
    const fr = await filesReady[i]; if (PF.cancel) break;
    if (!fr.ok) { pfMsg(i, fr.err, 'bad'); PF.rows[i].err = true; errs++; continue; }
    try { totalMB += await pfPrepare(i, songs[i], mode); } catch (e) { pfMsg(i, 'Помилка: ' + e.message, 'bad'); PF.rows[i].err = true; errs++; }
    const ready = PF.rows.filter((r) => r.done).length;
    if (ready >= 1 && $('#pfEnter').disabled) { $('#pfEnter').disabled = false; $('#pfEnter').textContent = '▶ Увійти зараз (решта готується у фоні)'; }
    if ($('#preflight').hidden && i < songs.length - 1) status(`Підготовка пісень у фоні: ${ready}/${songs.length}`);
  }
  clearInterval(PF.speedTimer); $('#pfEnter').textContent = '▶ Увійти в режим запуску';
  PF.running = false; if (PF.cancel) return;
  if ($('#preflight').hidden) status(errs ? `Підготовка завершена, проблем: ${errs}` : `Усі ${songs.length} пісень підготовлено`);
  const secs = ((performance.now() - PF.t0) / 1000).toFixed(0);
  $('#pfBar').style.width = '100%'; $('#pfPct').textContent = '100%';
  $('#pfSummary').textContent = `${songs.length - errs} з ${songs.length} пісень готові за ${secs} с · у пам'яті ≈ ${Math.round(totalMB)} МБ${mode === 'economy' ? ' (економний режим: поточна й наступна пісня)' : ''}${errs ? ` · проблем: ${errs}` : ''}`;
  $('#pfEnter').disabled = false; $('#pfRetry').hidden = !errs;
  if (!errs && $('#pfAuto').checked) setTimeout(() => { if (!$('#preflight').hidden && !PF.running) enterPerform(); }, 900);
}
async function enterPerform() {
  const list = S.setlist.map((id) => library.find((x) => x.id === id)).filter(Boolean);
  showScreen(null); renderSetlist();
  const okFirst = list.find((sg) => !PF.rows[S.setlist.indexOf(sg.id)]?.err) || list[0];
  if (okFirst && current !== okFirst) await loadSong(okFirst); else preloadNext();
}
$('#pfEnter').onclick = enterPerform;
$('#pfCancel').onclick = () => { PF.cancel = true; PF.running = false; clearInterval(PF.speedTimer); showScreen('home'); };
$('#pfRetry').onclick = () => { PF.running = false; startPreflight(); };
$('#pfMem').onchange = (e) => { S.memMode = e.target.value; save('memMode'); };
$('#hLaunch').onclick = startPreflight;

ensureSunday(); renderSetlist(); showScreen('home');

// Small hook for debugging / automated tests
window.PB = { seek, S, fadeGain: () => E.stems[0]?.fade.gain.value, pos: position, playing: () => E.playing, setFade, play, mark: markCurrentSection, addSong(song) { library.push(song); renderLibrary(); }, load: loadSong, state: () => ({ markers: E.markers, dur: E.dur, tempo: E.tempo, arr: S.arr[E.song?.id] || null, stems: E.stems.map((x) => ({ name: x.name, segs: x.segs.length })) }), ops: { opDelete, opDup, opMove, opSplit, opMergeNext, opRename, resetStructure, undoArr, detectGuide } };
