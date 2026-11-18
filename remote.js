// Phone remote — client side. Talks to the laptop app over a WebRTC data channel (PeerJS).
const $ = (s, el = document) => el.querySelector(s);
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let creds = null; try { creds = JSON.parse(localStorage.getItem('pbr') || 'null'); } catch {}
const hash = location.hash.slice(1);
if (hash.includes('.')) { const [id, pin] = hash.split('.'); creds = { id, pin }; localStorage.setItem('pbr', JSON.stringify(creds)); history.replaceState(null, '', location.pathname); }

let peer = null, conn = null, S = null, recvAt = 0, wantConnect = true, retryT = null, dragging = 0;

function setConn(on, msg) {
  $('#dot').classList.toggle('ok', on);
  if (msg) $('#status').textContent = msg;
}
function send(c, a) { if (conn && conn.open) { conn.send({ t: 'cmd', c, a: a || {} }); } try { navigator.vibrate?.(8); } catch {} }
const throttle = (fn, ms) => { let t = 0, last; return (...a) => { last = a; const n = Date.now(); if (n - t >= ms) { t = n; fn(...a); } else setTimeout(() => { if (Date.now() - t >= ms) { t = Date.now(); fn(...last); } }, ms); }; };

function connect() {
  clearTimeout(retryT);
  if (!creds) { $('#conn').classList.add('on'); return; }
  $('#conn').classList.remove('on');
  try { conn && conn.close(); peer && peer.destroy(); } catch {}
  setConn(false, 'Підключення…');
  peer = new window.Peer({ debug: 0 });
  peer.on('open', () => {
    conn = peer.connect(creds.id, { reliable: true });
    conn.on('open', () => conn.send({ t: 'hello', pin: creds.pin }));
    conn.on('data', onData);
    conn.on('close', () => { setConn(false, 'З’єднання втрачено…'); scheduleRetry(); });
    conn.on('error', () => scheduleRetry());
  });
  peer.on('error', (e) => { setConn(false, e.type === 'peer-unavailable' ? 'Ноутбук не знайдено: перевірте, що апка відкрита й пульт увімкнено' : 'Помилка зв’язку: ' + e.type); scheduleRetry(3000); });
}
function scheduleRetry(ms = 1500) { clearTimeout(retryT); if (wantConnect) retryT = setTimeout(connect, ms); }
setInterval(() => { if (S && Date.now() - recvAt > 9000) { S = null; setConn(false, 'Немає даних від ноутбука…'); scheduleRetry(200); } }, 2000);

function onData(d) {
  if (d.t === 'denied') { localStorage.removeItem('pbr'); creds = null; wantConnect = false; $('#connMsg').textContent = 'Невірний PIN або код. Спробуйте ще раз.'; $('#conn').classList.add('on'); return; }
  if (d.t !== 'state') return;
  S = d.s; recvAt = Date.now(); setConn(true, S.status || ''); render();
}

// ── rendering ──
let sigSec = '', sigSet = '', sigStems = '';
function render() {
  if (!S) return;
  $('#song').textContent = S.song || 'Оберіть пісню'; $('#bpm').textContent = S.bpm ? Math.round(S.bpm * 10) / 10 + ' BPM' : '';
  $('#play').textContent = S.playing ? '❚❚' : '▶'; $('#play').classList.toggle('playing', S.playing);
  $('#loop').classList.toggle('on', !!S.loop); $('#status').textContent = S.locked ? '🔒 Пісню закріплено · ' + (S.status || '') : (S.status || '');
  // sections
  const sig = JSON.stringify([S.sections, S.cur, S.queue, S.fade, S.dur]);
  if (sig !== sigSec) {
    sigSec = sig;
    const bar = $('#bar'); bar.innerHTML = '';
    S.sections.forEach((x) => { const e = document.createElement('div'); e.className = 'seg'; e.style.cssText = `left:${(x.a / S.dur) * 100}%;width:${((x.b - x.a) / S.dur) * 100}%;background:${x.c}`; bar.append(e); });
    if (S.fade) { const f = document.createElement('div'); f.className = 'fadeb'; f.style.cssText = `left:${(S.fade.t / S.dur) * 100}%;width:${(S.fade.dur / S.dur) * 100}%`; bar.append(f); }
    const ph = document.createElement('div'); ph.className = 'ph'; ph.id = 'ph'; bar.append(ph);
    const chips = $('#chips'); chips.innerHTML = '';
    S.sections.forEach((x, i) => {
      const b = document.createElement('button'); b.className = 'chip' + (i === S.cur ? ' cur' : '') + (S.queue === x.a ? ' q' : ''); b.style.setProperty('--c', x.c);
      b.innerHTML = `<span>${x.code}</span><small>${fmt(x.a)}</small>`; b.title = x.n;
      let timer = null, fired = false;
      b.onpointerdown = () => { fired = false; timer = setTimeout(() => { fired = true; send('jump', { t: x.a }); }, 450); };
      b.onpointerup = () => { clearTimeout(timer); if (!fired) send('queue', { t: x.a }); };
      b.onpointerleave = b.onpointercancel = () => clearTimeout(timer);
      chips.append(b);
    });
  }
  // setlist
  const ss = JSON.stringify(S.setlist);
  if (ss !== sigSet) {
    sigSet = ss; const box = $('#setlist'); box.innerHTML = '';
    S.setlist.forEach((x, i) => {
      const el = document.createElement('div'); el.className = 'songitem' + (x.cur ? ' cur' : ''); el.innerHTML = `<span class="i">${i + 1}</span><span></span>`; el.lastChild.textContent = x.name;
      el.onclick = () => { if (x.cur) return; if (S.playing && !confirm(`Зараз грає. Перейти до «${x.name}»?`)) return; send('load', { id: x.id }); show('play'); };
      box.append(el);
    });
    if (!S.setlist.length) box.innerHTML = '<div class="hint">Сетліст порожній — додайте пісні на ноутбуці.</div>';
  }
  // stems (update in place so dragging is not interrupted)
  const st = JSON.stringify(S.stems.map((x) => x.n));
  if (st !== sigStems) {
    sigStems = st; const box = $('#strips'); box.innerHTML = '';
    S.stems.forEach((x, i) => {
      const el = document.createElement('div'); el.className = 'st';
      el.innerHTML = `<div class="ms"><button class="s">S</button><button class="m">M</button></div><input type="range" min="0" max="1.5" step="0.01"><div class="n"></div>`;
      $('.n', el).textContent = x.n;
      const r = $('input', el), send2 = throttle((v) => send('vol', { i, v }), 60);
      r.oninput = () => send2(+r.value); r.onpointerdown = () => { dragging++; }; r.onpointerup = r.onpointercancel = () => { dragging = Math.max(0, dragging - 1); };
      $('.m', el).onclick = () => send('mute', { i }); $('.s', el).onclick = () => send('solo', { i });
      box.append(el);
    });
  }
  [...$('#strips').children].forEach((el, i) => {
    const x = S.stems[i]; if (!x) return;
    if (!dragging) $('input', el).value = x.v;
    $('.m', el).classList.toggle('on', x.m); $('.s', el).classList.toggle('on', x.s);
  });
  if (!dragging) $('#master').value = S.master;
  [...$('#padk').children].forEach((b) => b.classList.toggle('on', b.textContent === S.padKey));
  $('#mute').classList.toggle('on', S.stems.length && S.stems.every((x) => x.m));
}
function frame() {
  if (S) {
    let p = S.pos + (S.playing ? (Date.now() - recvAt) / 1000 : 0); p = Math.max(0, Math.min(S.dur || 0, p));
    $('#clock').textContent = `${String(Math.floor(p / 60)).padStart(2, '0')}:${String(Math.floor(p % 60)).padStart(2, '0')}`;
    $('#sub').textContent = `-${fmt(Math.max(0, (S.end || S.dur) - p))} / ${fmt(S.dur)}`;
    const ph = $('#ph'); if (ph && S.dur) ph.style.left = (p / S.dur) * 100 + '%';
  }
  requestAnimationFrame(frame);
}

// ── controls ──
$('#play').onclick = () => send('toggle'); $('#stop').onclick = () => send('stop');
$('#prev').onclick = () => send('prev'); $('#next').onclick = () => { if (S?.playing && !confirm('Перейти до наступної пісні?')) return; send('next'); };
$('#fade').onclick = () => send('fade', { s: 3 }); $('#loop').onclick = () => send('loop');
$('#nextsec').onclick = () => send('nextSection'); $('#mute').onclick = () => send('muteAll');
const sendMaster = throttle((v) => send('master', { v }), 60);
$('#master').oninput = (e) => sendMaster(+e.target.value);
$('#master').onpointerdown = () => { dragging++; }; $('#master').onpointerup = () => { dragging = Math.max(0, dragging - 1); };
KEYS.forEach((k) => { const b = document.createElement('button'); b.textContent = k; b.onclick = () => send('pad', { k }); $('#padk').append(b); });
$('#padstop').onclick = () => send('padStop');
function show(v) { document.querySelectorAll('.view').forEach((e) => e.classList.toggle('on', e.id === 'v-' + v)); document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => show(b.dataset.v)));
$('#go').onclick = () => { const id = $('#inId').value.trim(), pin = $('#inPin').value.trim(); if (!id || !pin) return; creds = { id, pin }; localStorage.setItem('pbr', JSON.stringify(creds)); wantConnect = true; connect(); };

// keep the screen on
async function wake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); if (!conn || !conn.open) connect(); } });
document.addEventListener('pointerdown', wake, { once: true });

frame(); connect();
