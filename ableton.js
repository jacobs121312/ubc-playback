// Ableton Live (.als) project importer: parses arrangement audio tracks/clips and maps them to playable segments.
export const AUDIO_RE = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff)$/i;

// ── Folder index (File System Access API) ──
export async function indexFolder(root, maxDepth = 6) {
  const files = [];                                   // {parts:[...], name, handle}
  async function walk(dir, parts, depth) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (depth < maxDepth && name !== 'Backup') await walk(h, [...parts, name], depth + 1); }
      else if (AUDIO_RE.test(name) || /\.als$/i.test(name) || name === 'markers-cache.json') files.push({ parts: [...parts, name], name, handle: h });
    }
  }
  await walk(root, [], 0);
  const byPath = new Map(), byName = new Map();
  for (const f of files) {
    byPath.set(f.parts.join('/').toLowerCase(), f);
    const k = f.name.toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f);
  }
  return { files, byPath, byName, projects: files.filter((f) => /\.als$/i.test(f.name)) };
}

// ── .als parsing ──
async function readAls(file) {
  const text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return new DOMParser().parseFromString(text, 'application/xml');
}
const val = (el, sel) => el.querySelector(sel)?.getAttribute('Value') ?? null;
const num = (el, sel, d = 0) => { const v = val(el, sel); return v == null ? d : +v; };

function warpMap(markers) {                          // source beats -> file seconds (piecewise linear, extrapolated)
  const m = [...markers].sort((a, b) => a.beat - b.beat);
  if (m.length < 2) return (b) => b;
  return (b) => {
    let i = 0; while (i < m.length - 2 && b > m[i + 1].beat) i++;
    const a = m[i], c = m[i + 1];
    return a.sec + ((b - a.beat) * (c.sec - a.sec)) / (c.beat - a.beat);
  };
}

function clipSegments(c, spb) {
  const aps = c.warped ? spb : 1;                    // arrangement seconds per source unit
  const toFile = c.warped ? warpMap(c.warps) : (u) => u;
  let t = c.start * spb;
  let left = c.warped ? c.end - c.start : (c.end - c.start) * spb;
  let p = c.loopStart + c.startRel;
  const L = c.loopEnd - c.loopStart;
  if (c.loopOn && L > 0) p = c.loopStart + ((((p - c.loopStart) % L) + L) % L);
  const segs = [];
  for (let n = 0; left > 1e-6 && n < 5000; n++) {
    const take = Math.min(left, c.loopOn && L > 0 ? c.loopEnd - p : Infinity);
    if (take <= 1e-9) { p = c.loopStart; continue; }
    const fs = toFile(p), fe = toFile(p + take), d = take * aps;
    segs.push({ t, d, off: fs, rate: c.warped ? (fe - fs) / d : 1 });
    t += d; left -= take; p = c.loopOn && L > 0 ? c.loopStart : p + take;
  }
  return segs;
}

export async function parseProject(file) {
  const doc = await readAls(file);
  const ls = doc.querySelector('LiveSet');
  const master = ls.querySelector(':scope > MainTrack, :scope > MasterTrack');
  const tempo = num(master, 'Tempo > Manual', 120);
  const warnings = [];
  const tgt = master.querySelector('Tempo > AutomationTarget')?.getAttribute('Id');
  if (tgt) for (const env of master.querySelectorAll('AutomationEnvelope'))
    if (val(env, 'EnvelopeTarget > PointeeId') === tgt && env.querySelectorAll('FloatEvent').length > 1)
      warnings.push('Є автоматизація темпу — імпорт припускає сталий темп ' + tempo + ' BPM.');
  const spb = 60 / tempo;
  const markers = [...ls.querySelectorAll(':scope > Locators > Locators > Locator')]
    .map((l) => ({ t: num(l, ':scope > Time') * spb, name: val(l, ':scope > Name') || '' })).sort((a, b) => a.t - b.t);

  const tracks = [];
  const skippedKinds = {};
  for (const tr of ls.querySelectorAll(':scope > Tracks > *')) {
    const nm = (val(tr, ':scope > Name > EffectiveName') || tr.tagName).replace(/^\d+\s*-\s*/, '').trim() || tr.tagName;
    if (tr.tagName !== 'AudioTrack') {
      if (tr.tagName !== 'ReturnTrack' && tr.querySelector('MidiClip, AudioClip')) (skippedKinds[tr.tagName] ||= []).push(nm);
      continue;
    }
    const clips = [...tr.querySelectorAll('ArrangerAutomation > Events > AudioClip')].map((c) => ({
      start: num(c, ':scope > CurrentStart'), end: num(c, ':scope > CurrentEnd'),
      loopStart: num(c, ':scope > Loop > LoopStart'), loopEnd: num(c, ':scope > Loop > LoopEnd'),
      startRel: num(c, ':scope > Loop > StartRelative'), loopOn: val(c, ':scope > Loop > LoopOn') === 'true',
      warped: val(c, ':scope > IsWarped') === 'true', disabled: val(c, ':scope > Disabled') === 'true',
      warps: [...c.querySelectorAll(':scope > WarpMarkers > WarpMarker')].map((w) => ({ sec: +w.getAttribute('SecTime'), beat: +w.getAttribute('BeatTime') })),
      rel: val(c, 'SampleRef > FileRef > RelativePath'), abs: val(c, 'SampleRef > FileRef > Path'),
    })).filter((c) => !c.disabled && c.end > c.start);
    if (!clips.length) continue;
    tracks.push({
      name: nm, clips, vol: Math.min(1.5, num(tr, ':scope > DeviceChain > Mixer > Volume > Manual', 1)),
      enabled: val(tr, ':scope > DeviceChain > Mixer > Speaker > Manual') !== 'false',
    });
  }
  for (const [k, v] of Object.entries(skippedKinds)) warnings.push(`${k} з кліпами не імпортовано (потрібен експорт аудіо з Live): ${v.join(', ')}`);
  return { tempo, spb, markers, tracks, warnings };
}

// ── resolve + decode + build stems ──
function findFile(index, alsParts, clip) {
  const dir = alsParts.slice(0, -1);
  const cands = [];
  if (clip.rel) {
    const out = [...dir];
    for (const p of clip.rel.split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    cands.push(out.join('/'));
    cands.push([...dir, ...clip.rel.split('/').filter((p) => p !== '..' && p !== '.')].join('/'));
  }
  for (const c of cands) { const f = index.byPath.get(c.toLowerCase()); if (f) return f; }
  const base = (clip.rel || clip.abs || '').split(/[\\/]/).pop().toLowerCase();
  const hits = index.byName.get(base) || [];
  return hits.find((h) => h.parts.slice(0, -1).join('/').startsWith(dir.join('/'))) || hits[0] || null;
}

function maybeMono(buf, ctx) {
  if (buf.numberOfChannels !== 2) return buf;
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return buf;
  const m = ctx.createBuffer(1, buf.length, buf.sampleRate); m.copyToChannel(a, 0); return m;
}

export async function loadProject(entry, index, ctx, onProgress = () => {}) {
  const proj = await parseProject(await entry.handle.getFile());
  const warnings = [...proj.warnings];
  const cache = new Map();
  const getBuf = async (f) => {
    const k = f.parts.join('/');
    if (!cache.has(k)) cache.set(k, (async () => maybeMono(await ctx.decodeAudioData(await (await f.handle.getFile()).arrayBuffer()), ctx))());
    return cache.get(k);
  };
  let done = 0; const total = proj.tracks.length;
  const stems = [];
  let stretched = false;
  await Promise.all(proj.tracks.map(async (tr) => {
    if (/^tempo$/i.test(tr.name)) { done++; return; }
    const segs = [];
    for (const clip of tr.clips) {
      const f = findFile(index, entry.parts, clip);
      if (!f) { warnings.push(`«${tr.name}»: не знайдено файл ${(clip.rel || clip.abs || '?').split(/[\\/]/).pop()}`); continue; }
      let buffer; try { buffer = await getBuf(f); } catch (e) { warnings.push(`«${tr.name}»: не вдалось декодувати ${f.name}`); continue; }
      for (const s of clipSegments(clip, proj.spb)) {
        if (Math.abs(s.rate - 1) > 0.005) stretched = true;
        segs.push({ ...s, buffer });
      }
    }
    onProgress(++done, total);
    if (!segs.length) return;
    segs.sort((a, b) => a.t - b.t);
    const merged = [];
    for (const s of segs) {
      const p = merged[merged.length - 1];
      if (p && p.buffer === s.buffer && Math.abs(s.t - (p.t + p.d)) < 1e-3 && Math.abs(s.rate - p.rate) < 1e-6 && Math.abs(s.off - (p.off + p.d * p.rate)) < 2e-3) p.d += s.d;
      else merged.push({ ...s });
    }
    for (const s of merged) {
      s.cutIn = s.off > 0.0005;
      s.cutOut = s.off + s.d * s.rate < s.buffer.duration - 0.0005;
    }
    stems.push({ order: proj.tracks.indexOf(tr), name: tr.name, segs: merged, vol: tr.vol, mute: !tr.enabled,
      channels: Math.max(...merged.map((s) => s.buffer.numberOfChannels)) });
  }));
  stems.sort((a, b) => a.order - b.order);
  if (stretched) warnings.push('Деякі кліпи розтягнуті (warp): відтворено зі зміною швидкості, тож висота тону може відрізнятись. Для точного результату зробіть в Live Export Audio → All Individual Tracks.');
  const dur = Math.max(0, ...stems.flatMap((s) => s.segs.map((g) => g.t + g.d)));
  return { stems, dur, tempo: proj.tempo, markers: proj.markers.filter((m) => m.t <= dur), warnings };
}
