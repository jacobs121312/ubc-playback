// Playback web app: multitrack stems -> routable outputs (Dante Virtual Soundcard / any multichannel device)
import { indexFolder, loadProject, AUDIO_RE as ABL_AUDIO } from './ableton.js';
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
  autoAdvance: store.get('autoAdvance', true), xform: store.get('xform', {}),
};
const save = (k) => store.set(k, S[k]);
const status = (t) => { $('#status').textContent = t; };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const key = (n) => n.trim().toLowerCase();

// ───────────── Audio engine ─────────────
const E = { tempo: 1, markers: [], ctx: null, merger: null, master: null, nOut: 2, maxOut: 2, stems: [], song: null,
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
  st.g.connect(st.an); st.g.connect(st.split);
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
const startPos = () => (trimOf().start || 0) / E.tempo;
const endPos = () => (trimOf().end ? Math.min(trimOf().end / E.tempo, E.dur) : E.dur);
function position() {
  if (E.pendingJump && E.ctx.currentTime >= E.pendingJump.tb) { E.startedAt = E.pendingJump.tb - E.pendingJump.target; E.pendingJump = null; }
  return E.playing ? Math.min(E.ctx.currentTime - E.startedAt, E.dur) : E.pos;
}
// Sample-accurate jump: old sources stop at song position `at`, new ones start there from `target` (gapless section loops/queues).
function jumpAt(at, target) {
  const tb = E.startedAt + at;
  E.sources.forEach((s) => { try { s.stop(tb); } catch {} });
  E.sources.push(...E.stems.flatMap((st) => schedule(E.ctx, st, st.g, tb, target)));
  E.pendingJump = { tb, target };
}
function sections() {
  const m = E.markers; if (!m.length) return [];
  return m.map((x, i) => ({ name: x.name, start: x.t, end: i + 1 < m.length ? m[i + 1].t : E.dur }));
}
const sectionAt = (p) => sections().find((s) => p >= s.start - 0.001 && p < s.end - 0.001);
async function play(lead = 0.12) {
  if (!E.stems.length || E.playing) return;
  await E.ctx.resume();
  const t0 = E.ctx.currentTime + lead;
  if (E.pos >= endPos() - 0.05) E.pos = startPos();
  E.sources = E.stems.flatMap((st) => schedule(E.ctx, st, st.g, t0, E.pos));
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
  if (p >= endPos() - 0.05 && !E.pendingJump) { stop(); if (S.autoAdvance) advance(1, true); }
}, 25);
function halt() { E.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch {} }); E.sources = []; }
function pause() { if (!E.playing) return; E.pos = position(); halt(); E.playing = false; syncPlayBtn(); }
function stop() { halt(); E.playing = false; E.pendingJump = null; E.queue = null; E.pos = startPos(); syncPlayBtn(); }
function seek(t) { const was = E.playing; if (was) { halt(); E.playing = false; E.pendingJump = null; } E.pos = t; if (was) play(0.03); }
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

async function driveStemFiles(songId) {
  try {
    const files = (await dList(`'${songId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      'id,name,md5Checksum,modifiedTime')).filter((f) => AUDIO_RE.test(f.name));
    S.index[songId] = files; save('index'); return files;
  } catch (e) { if (S.index[songId]) return S.index[songId]; throw e; }
}
async function driveBuf(f) {
  const cache = await caches.open('stems-v1');
  const k = `https://stems.local/${f.id}/${f.md5Checksum || f.modifiedTime}`;
  const hit = await cache.match(k); if (hit) return hit.arrayBuffer();
  const buf = await (await dFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`)).arrayBuffer();
  await cache.put(k, new Response(buf.slice(0))); return buf;
}
function monoIfDual(buf) {     // dual-mono stereo files -> mono (halves RAM)
  if (buf.numberOfChannels !== 2) return buf;
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return buf;
  const m = E.ctx.createBuffer(1, buf.length, buf.sampleRate); m.copyToChannel(a, 0); return m;
}
async function decodeAll(items, label) {            // items: [{name, get:()=>Promise<ArrayBuffer>}]
  let n = 0;
  return Promise.all(items.map(async (it) => {
    const ab = await it.get();
    const buffer = monoIfDual(await E.ctx.decodeAudioData(ab.slice(0)));
    status(`${label}: ${++n}/${items.length}`);
    return { name: it.name, channels: buffer.numberOfChannels, segs: [{ t: 0, d: buffer.duration, off: 0, rate: 1, buffer }] };
  }));
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
  library = library.filter((s) => s.src !== 'drive').concat(folders.map((f) => ({
    id: f.id, name: f.name, src: 'drive',
    load: async () => decodeAll((await driveStemFiles(f.id)).map((x) => ({ name: stemName(x.name), get: () => driveBuf(x) })), f.name),
    prefetch: async () => { for (const x of await driveStemFiles(f.id)) await driveBuf(x); },
  })));
  renderLibrary(); status(`Drive: ${folders.length} пісень`);
}
function offlineDrive() {       // show cached Drive songs without login
  const folders = store.get('driveSongs', []);
  if (!folders.length) return;
  library = library.concat(folders.map((f) => ({
    id: f.id, name: f.name, src: 'drive',
    load: async () => decodeAll((S.index[f.id] || []).map((x) => ({ name: stemName(x.name), get: () => driveBuf(x) })), f.name),
    prefetch: async () => {},
  })));
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
    load: async () => decodeAll((await audioIn(h)).map((f) => ({ name: stemName(f.name), get: async () => (await f.getFile()).arrayBuffer() })), name),
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
async function loadSong(song, xf = S.xform[song.id]) {
  stop(); current = song; renderLibrary(); renderSetlist();
  $('#songName').textContent = song.name; $('#songMeta').textContent = 'завантаження…';
  try {
    let items = song.src === 'demo' ? demoSong() : await song.load();
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
    if (xf && (xf.semi || xf.tempo !== 1)) await transformStems(xf.semi, xf.tempo);
    if (current !== song) return;
    E.ablMarkers = extra.markers || []; E.pos = startPos(); showTrim();
    E.bpm = extra.tempo ? extra.tempo * E.tempo : 0; $('#bpm').textContent = E.bpm ? String(Math.round(E.bpm * 10) / 10).replace(/\.0$/, '') : '—';
    computePeaks(); drawWave(); rebuildMarkers();
    E.stems.forEach(buildStemNodes);
    $('#songMeta').textContent = `${E.stems.length} стемів · ${fmt(E.dur)}` + (extra.tempo ? ` · ${extra.tempo} BPM` : '');
    renderMarkers(); renderReport(extra.warnings || []);
    syncXform(); status('Готово'); renderMixer(); renderMatrix();
  } catch (e) { $('#songMeta').textContent = 'помилка: ' + e.message; status('Помилка: ' + e.message); }
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
    const h = hueOf(sg.name), ini = sg.name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const x = S.xform[sg.id], tag = x ? [x.semi ? (x.semi > 0 ? '+' : '') + x.semi + ' ст' : '', x.tempo !== 1 ? Math.round(x.tempo * 100) + '%' : ''].filter(Boolean).join(' ') : '';
    const el = document.createElement('div'); el.className = 'card' + (sg === current ? ' cur' : '');
    el.innerHTML = '<div class="art"><i>→</i></div><div class="nm"></div>';
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

function rebuildMarkers() {
  const mine = (S.markers[E.song?.id] || []);
  E.markers = [...(E.ablMarkers || []), ...mine].map((m) => ({ ...m, t0: m.t, t: m.t / E.tempo })).sort((a, b) => a.t - b.t);
  renderMarkers();
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
    b.title = `${sc.name || 'секція'} · ${fmt(sc.start)}\nКлік — перейти в кінці поточної секції; подвійний клік — одразу; ПКМ — видалити свою мітку`;
    b.onclick = (e) => { e.stopPropagation(); if (E.playing) { E.queue = sc.start; renderMarkers(); } else seek(sc.start); };
    b.ondblclick = (e) => { e.stopPropagation(); E.queue = null; seek(sc.start); renderMarkers(); };
    b.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation(); const mine = S.markers[E.song.id] || [];
      const k = mine.findIndex((x) => x.t === m.t0 && x.name === m.name);
      if (k >= 0) { mine.splice(k, 1); S.markers[E.song.id] = mine; save('markers'); rebuildMarkers(); }
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
$('#wave').onclick = (e) => { if (!E.dur) return; const r = e.currentTarget.getBoundingClientRect(); E.queue = null; seek(((e.clientX - r.left) / r.width) * E.dur); renderMarkers(); };
function markCurrentSection() {
  if (!E.song) return;
  const name = prompt('Назва секції (Verse, Chorus, Bridge…)', ''); if (name === null) return;
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
let ablIndex = null;
async function openAbleton() {
  if (!window.showDirectoryPicker) return status('Потрібен Chrome/Edge');
  const root = await showDirectoryPicker();
  status('Шукаю проєкти Ableton…');
  ablIndex = await indexFolder(root);
  const projects = ablIndex.projects;
  library = library.filter((s) => s.src !== 'als').concat(projects.map((p) => ({
    id: 'als:' + p.parts.join('/'), name: p.name.replace(/\.als$/i, ''), src: 'als', prefetch: async () => {},
    load: async () => loadProject(p, ablIndex, E.ctx, (d, n) => status(`${p.name}: ${d}/${n} треків`)),
  })));
  renderLibrary(); status(`Знайдено проєктів Ableton: ${projects.length}`);
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
    const oc = new OfflineAudioContext(st.channels, Math.ceil(E.dur * 48000), 48000);
    const g = oc.createGain(); g.gain.value = st.vol; g.connect(oc.destination);
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
async function transformStems(semi, tempo) {
  const jobs = new Map();                                    // buffer -> Map(noPitch -> processed buffer)
  E.stems.forEach((st) => st.segs.forEach((g) => {
    const f = NO_PITCH.test(st.name); if (!jobs.has(g.buffer)) jobs.set(g.buffer, new Map()); jobs.get(g.buffer).set(f, null);
  }));
  const queue = [...jobs].flatMap(([buf, m]) => [...m.keys()].map((f) => ({ buf, f })));
  const total = queue.length; let done = 0; const t0 = performance.now();
  const N = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  await Promise.all(Array.from({ length: N }, async () => {
    const w = new Worker('stretch-worker.js', { type: 'module' });
    try {
      while (queue.length) {
        const { buf, f } = queue.shift();
        jobs.get(buf).set(f, await runWorker(w, buf, f ? 0 : semi, tempo));
        status(`Зміна тональності/темпу: ${++done}/${total}`);
      }
    } finally { w.terminate(); }
  }));
  E.stems.forEach((st) => {
    const f = NO_PITCH.test(st.name);
    st.segs = st.segs.map((g) => ({ ...g, t: g.t / tempo, d: g.d / tempo, off: g.off / tempo, buffer: jobs.get(g.buffer).get(f) }));
  });
  E.dur /= tempo; E.tempo = tempo;
  status(`Готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
}
function syncXform() {
  const x = S.xform[current?.id] || { semi: 0, tempo: 1 };
  $('#xSemi').value = x.semi; $('#xTempo').value = Math.round(x.tempo * 100); $('#xTempoVal').textContent = Math.round(x.tempo * 100) + '%';
}
for (let i = -6; i <= 6; i++) $('#xSemi').append(new Option(i > 0 ? '+' + i : String(i), i));
$('#xSemi').value = 0;
$('#xTempo').oninput = (e) => { $('#xTempoVal').textContent = e.target.value + '%'; };
$('#xApply').onclick = () => {
  if (!current) return;
  const x = { semi: +$('#xSemi').value, tempo: +$('#xTempo').value / 100 };
  if (x.semi || x.tempo !== 1) S.xform[current.id] = x; else delete S.xform[current.id];
  save('xform'); loadSong(current, x);
};
$('#xReset').onclick = () => { if (!current) return; delete S.xform[current.id]; save('xform'); loadSong(current, null); };

// ── Section / trim / transport extras ──
$('#btnLoop').onclick = () => { E.loop = !E.loop; $('#btnLoop').classList.toggle('on', E.loop); };
$('#btnMark').onclick = markCurrentSection;
function nextSection() {
  const s = sections(); if (!s.length) return;
  const i = s.findIndex((x) => x === sectionAt(position())); const nx = s[i + 1];
  if (!nx) return; if (E.playing) { E.queue = nx.start; renderMarkers(); } else seek(nx.start);
}
const setTrim = (patch) => { if (!E.song) return; S.trim[E.song.id] = { ...trimOf(), ...patch }; save('trim'); showTrim(); };
function showTrim() { const t = trimOf(); $('#trimInfo').textContent = t.start || t.end ? `обрізка: ${fmt(startPos())}–${fmt(endPos())}` : ''; }
$('#btnStartHere').onclick = () => setTrim({ start: Math.round(position() * E.tempo * 100) / 100 });
$('#btnEndHere').onclick = () => setTrim({ end: Math.round(position() * E.tempo * 100) / 100 });
$('#btnClearTrim').onclick = () => { if (E.song) { delete S.trim[E.song.id]; save('trim'); showTrim(); } };
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
