// Playback web app: multitrack stems -> routable outputs (Dante Virtual Soundcard / any multichannel device)
import { indexFolder, loadProject, AUDIO_RE as ABL_AUDIO } from './ableton.js';
const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('pb.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('pb.' + k, JSON.stringify(v)); },
};
const S = {
  clientId: store.get('clientId', '403195791032-2167k60jjh457umlg20siumv0iu0ogph.apps.googleusercontent.com'), rootFolder: store.get('rootFolder', ''),
  deviceId: store.get('deviceId', ''), outCount: store.get('outCount', 0),
  patch: store.get('patch', {}), outNames: store.get('outNames', []), setlist: store.get('setlist', []),
  index: store.get('index', {}),
};
const save = (k) => store.set(k, S[k]);
const status = (t) => { $('#status').textContent = t; };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const key = (n) => n.trim().toLowerCase();

// ───────────── Audio engine ─────────────
const E = { markers: [], ctx: null, merger: null, master: null, nOut: 2, maxOut: 2, stems: [], song: null,
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

function position() { return E.playing ? Math.min(E.ctx.currentTime - E.startedAt, E.dur) : E.pos; }
async function play() {
  if (!E.stems.length || E.playing) return;
  await E.ctx.resume();
  const t0 = E.ctx.currentTime + 0.12;
  if (E.pos >= E.dur - 0.05) E.pos = 0;
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
setInterval(() => {          // end-of-song detection (works even if tab is in background)
  if (E.playing && position() >= E.dur - 0.05) { stop(); advance(1, true); }
}, 200);
function halt() { E.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch {} }); E.sources = []; }
function pause() { if (!E.playing) return; E.pos = position(); halt(); E.playing = false; syncPlayBtn(); }
function stop() { halt(); E.playing = false; E.pos = 0; syncPlayBtn(); }
function seek(t) { const was = E.playing; if (was) { halt(); E.playing = false; } E.pos = t; if (was) play(); }
const syncPlayBtn = () => { $('#btnPlay').textContent = E.playing ? '❚❚' : '▶'; };

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
async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (!S.clientId) throw new Error('Вкажіть OAuth Client ID у Налаштуваннях');
  await loadGIS();
  return new Promise((res, rej) => {
    google.accounts.oauth2.initTokenClient({
      client_id: S.clientId, scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (r) => { if (r.error) rej(new Error(r.error)); else { token = r.access_token; tokenExp = Date.now() + r.expires_in * 1000; res(token); } },
      error_callback: (e) => rej(new Error(e.type || 'auth error')),
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
async function loadSong(song) {
  stop(); current = song; renderLibrary(); renderSetlist();
  $('#songName').textContent = song.name; $('#songMeta').textContent = 'завантаження…';
  try {
    let items = song.src === 'demo' ? demoSong() : await song.load();
    if (current !== song) return;
    let extra = { markers: [], warnings: [], tempo: 0, dur: 0 };
    if (!Array.isArray(items)) { extra = items; items = items.stems; }
    E.song = song; E.pos = 0;
    E.stems = items.map((it) => {
      const segs = it.segs || [{ t: 0, d: it.buffer.duration, off: 0, rate: 1, buffer: it.buffer }];
      return { ...it, segs, channels: it.channels || segs[0].buffer.numberOfChannels, vol: it.vol ?? 1, mute: it.mute ?? false, solo: false };
    });
    E.dur = extra.dur || Math.max(...E.stems.flatMap((s) => s.segs.map((g) => g.t + g.d)));
    E.markers = extra.markers || [];
    E.stems.forEach(buildStemNodes);
    $('#songMeta').textContent = `${E.stems.length} стемів · ${fmt(E.dur)}` + (extra.tempo ? ` · ${extra.tempo} BPM` : '');
    renderMarkers(); renderReport(extra.warnings || []);
    status('Готово'); renderMixer(); renderMatrix();
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
function renderSetlist() {
  const ul = $('#setlist'); ul.innerHTML = '';
  S.setlist.forEach((id, i) => {
    const s = library.find((x) => x.id === id); if (!s) return;
    const li = document.createElement('li'); if (s === current) li.className = 'cur';
    li.innerHTML = `<small>${i + 1}</small><span></span><button>✕</button>`; li.querySelector('span').textContent = s.name;
    li.onclick = () => loadSong(s);
    li.querySelector('button').onclick = (e) => { e.stopPropagation(); S.setlist.splice(i, 1); save('setlist'); renderSetlist(); };
    ul.append(li);
  });
}
const routeLabel = (st) => { const r = routesFor(st.name); return r.length ? '→ ' + r.map((c) => c + 1).join('·') : 'не патчено'; };
function renderMixer() {
  const box = $('#strips'); box.innerHTML = '';
  E.stems.forEach((st) => {
    const el = document.createElement('div'); el.className = 'strip';
    el.innerHTML = `<div class="nm"></div><div class="rt"></div>
      <div class="fader"><input type="range" min="0" max="1.5" step="0.01"><div class="meter"><i></i></div></div>
      <div class="ms"><button class="m">M</button><button class="s">S</button></div>`;
    $('.nm', el).textContent = st.name; $('.rt', el).textContent = routeLabel(st);
    const f = $('input', el); f.value = st.vol; f.oninput = () => { st.vol = +f.value; applyGain(st); };
    f.ondblclick = () => { f.value = st.vol = 1; applyGain(st); };
    $('.m', el).onclick = (e) => { st.mute = !st.mute; e.target.classList.toggle('on', st.mute); applyGain(st); };
    $('.s', el).onclick = (e) => { st.solo = !st.solo; e.target.classList.toggle('on', st.solo); E.stems.forEach(applyGain); };
    $('.m', el).classList.toggle('on', st.mute); f.value = st.vol;
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

function renderMarkers() {
  const box = $('#markers'); box.innerHTML = '';
  E.markers.forEach((m) => {
    const b = document.createElement('button'); b.textContent = `${m.name || '•'} · ${fmt(m.t)}`;
    b.onclick = () => seek(m.t); box.append(b);
  });
}
function renderReport(w) {
  const d = $('#report'); d.hidden = !w.length;
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
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + t; });
  if (t === 'patch') renderMatrix();
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
    const p = position(); $('#time').textContent = `${fmt(p)} / ${fmt(E.dur)}`;
    if (!seeking) $('#seek').value = E.dur ? (p / E.dur) * 1000 : 0;
    E.stems.forEach((st) => {
      if (!st.meter || !st.an) return;
      st.an.getFloatTimeDomainData(st.data);
      let pk = 0; for (const v of st.data) pk = Math.max(pk, Math.abs(v));
      st.meter.style.height = Math.min(100, pk * 100) + '%';
    });
  }
  requestAnimationFrame(tick);
}
let seeking = false;

// ───────────── Wiring ─────────────
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
$('#btnPlay').onclick = () => (E.playing ? pause() : play());
$('#btnStop').onclick = stop;
$('#btnPrev').onclick = () => advance(-1);
$('#btnNext').onclick = () => advance(1);
$('#seek').oninput = () => { seeking = true; };
$('#seek').onchange = (e) => { seeking = false; seek((e.target.value / 1000) * E.dur); };
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

offlineDrive(); renderLibrary(); renderSetlist();
await initAudio(); await fillDevices(); tick();
status(`Вихід: ${E.nOut} кан.`);
