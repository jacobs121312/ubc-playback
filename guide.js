// Section detection from a Guide stem: spoken cues ("Verse 1", "Chorus"…) -> markers.
// Port of the approach in the team's setlist.py (burst detection + whisper + label rules).
export const SECTION = /^(intro|verse|chorus|pre-?chorus|post-?chorus|bridge|interlude|instrumental|tag|refrain|turn ?around|ending|outro|vamp|breakdown|build|drums|all in|break|softly|slowly build|last time|big ending|solo|full band|a ?cappella|key change|hits)/i;
const VOCAB = ['intro', 'verse', 'chorus', 'prechorus', 'pre-chorus', 'postchorus', 'bridge', 'interlude', 'instrumental', 'tag', 'refrain', 'turnaround', 'turn around', 'ending', 'outro', 'vamp', 'breakdown', 'build', 'solo'];
const NUM = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', won: '1', to: '2', too: '2', for: '4' };

function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const TITLE = { 'pre-chorus': 'Pre-Chorus', prechorus: 'Pre-Chorus', 'post-chorus': 'Post-Chorus', postchorus: 'Post-Chorus', turnaround: 'Turnaround', 'turn around': 'Turnaround' };
const cap = (w) => TITLE[w] || w.charAt(0).toUpperCase() + w.slice(1);

// Short, easily-misheard words are matched by their consonant skeleton ("control" ~ "intro", "i'll draw" ~ "outro").
const skel = (w) => w.replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
const ALIAS = [
  [/\b(in ?tro|intra|in trail|and tro|entro|in true|control|introduction)\b/, 'intro'],
  [/\b(out ?tro|outra|i'?ll draw|outdoor|out of|ou ?tro|the outro|outer)\b/, 'outro'],
  [/\b(pre|pray|pree|kree|free|three|pri)[ -]?(chorus|chores|choruses|courus|coris|korus)\b/, 'pre-chorus'],
  [/\b(post|poss)[ -]?(chorus|chores)\b/, 'post-chorus'],
  [/\b(inter ?lude|interlood|in the lewd|interlewd)\b/, 'interlude'],
  [/\b(turn ?around|turn around)\b/, 'turnaround'],
  [/\b(instrumental|instrument)\b/, 'instrumental'],
  [/\b(chorus|chores|choruses|courus|korus|chorous)\b/, 'chorus'],
  [/\b(verse|versa|first|vers|worse|burst)\b/, 'verse'],
  [/\b(bridge|brige|breach|brich)\b/, 'bridge'],
  [/\b(ending|end)\b/, 'ending'],
  [/\b(tag|tack|tab)\b/, 'tag'],
  [/\b(vamp|vamps|camp)\b/, 'vamp'],
  [/\b(breakdown|break down)\b/, 'breakdown'],
];

// "Verse one." / "Chorus" / "Kree chorus" / "Verse, 2, 3" -> "Verse 1" | "Pre-Chorus" | null
export function labelFromText(text) {
  const t = (text || '').toLowerCase().replace(/[\[\(].*?[\]\)]/g, ' ').replace(/[^a-z0-9,.' \-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chunks = t.split(/[,.]/).map((c) => c.trim()).filter(Boolean);
  if (!chunks.length) return null;
  const first = chunks[0].split(' ').map((w) => NUM[w] || w).join(' ');
  let label = null;
  for (const [re, name] of ALIAS) if (re.test(first)) { label = cap(name); break; }
  if (!label) {                                              // fuzzy on the first word, then consonant skeleton for intro/outro
    const w0 = first.split(' ')[0].replace(/-$/, '');
    let best = null, bd = 9;
    for (const v of VOCAB) { const d = lev(w0, v); if (d < bd && d <= (v.length >= 6 ? 2 : 1)) { bd = d; best = v; } }
    if (best) label = cap(best);
    else if (w0.length >= 4 && /ntr/.test(skel(w0)) && !/(chorus|verse)/.test(first)) label = 'Intro';
  }
  if (!label) return null;
  let num = first.split(' ').slice(1).find((w) => /^\d$/.test(w));
  const countStyle = chunks.length > 1 && /^\d+$/.test(chunks[1]) && chunks.length > 2;   // «Verse, 2, 3» is a count
  if (!num && !countStyle && chunks.length > 1 && /^\d$/.test(chunks[1])) num = chunks[1];
  if (num && !countStyle && ['Verse', 'Chorus', 'Bridge', 'Pre-Chorus', 'Tag', 'Interlude', 'Refrain'].includes(label)) label += ' ' + num;
  return label;
}

// Spoken phrases, robust to a click mixed in: a 60 ms minimum filter wipes out clicks, speech stays.
export function speechBursts(x, sr, rel = 0.05) {
  const st = Math.floor(sr * 0.005), nf = Math.floor(x.length / st) - 1;
  if (nf < 20) return [];
  const env = new Float32Array(nf);
  for (let i = 0; i < nf; i++) { let s = 0; for (let k = 0; k < st; k++) s += Math.abs(x[i * st + k]); env[i] = s / st; }
  const K = 12, er = new Float32Array(nf); let mx = 0;
  for (let i = 0; i < nf; i++) { let m = Infinity; for (let k = i; k < Math.min(nf, i + K); k++) if (env[k] < m) m = env[k]; er[i] = m; if (m > mx) mx = m; }
  const thr = mx * rel, out = []; let start = null, last = null;
  for (let i = 0; i < nf; i++) {
    if (er[i] > thr) { if (start === null) start = i; last = i; }
    else if (start !== null && (i - last) * 0.005 > 0.35) { if ((last - start) * 0.005 >= 0.15) out.push([start, last]); start = null; }
  }
  if (start !== null && (last - start) * 0.005 >= 0.15) out.push([start, last]);
  return out.map(([a, b]) => {
    let pk = 0; for (let i = a; i <= b; i++) if (er[i] > pk) pk = er[i];
    let i = a; while (i > Math.max(0, a - 50) && er[i - 1] > pk * 0.04) i--;
    return { onset: i * 0.005, start: a * 0.005, end: (b + 1) * 0.005 };
  });
}

// x: mono Float32Array at sr (16 kHz); transcribe(Float32Array) -> Promise<string>
export async function detectSections(x, sr, transcribe, onProgress = () => {}) {
  for (const rel of [0.05, 0.025, 0.012]) {
    const bursts = speechBursts(x, sr, rel).filter((b) => b.end - b.start <= 3.0);
    const res = []; let last = null, done = 0;
    for (const b of bursts) {
      const a = Math.max(0, Math.floor((b.start - 0.4) * sr)), e = Math.min(x.length, Math.floor((b.end + 0.4) * sr));
      const text = await transcribe(x.slice(a, e));
      onProgress(++done, bursts.length, rel);
      const lab = labelFromText(text);
      if (!lab) continue;
      if (last !== null && b.onset - last <= 4.5 && res.length) { res[res.length - 1].name += ' ' + lab.toLowerCase(); last = b.onset; continue; }
      res.push({ t: Math.round(Math.max(0, b.onset - 0.01) * 1000) / 1000, name: lab }); last = b.onset;
    }
    if (res.length >= 3) return res;
    if (rel === 0.012) return res;
  }
  return [];
}
