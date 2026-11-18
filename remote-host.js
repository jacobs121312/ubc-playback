// Phone remote — host side (runs inside the laptop app). WebRTC data channel via PeerJS; only signalling touches the PeerJS cloud server.
export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src; s.onload = res; s.onerror = () => rej(new Error('не вдалось завантажити ' + src));
    document.head.append(s);
  });
}

export async function startHost({ id, pin, getState, exec, onStatus }) {
  await loadScript('vendor/peerjs.min.js');
  const peer = new window.Peer(id, { debug: 0 });
  const clients = new Set();
  let last = '', idle = 0, stopped = false;
  const notify = (extra = {}) => onStatus({ signalling: peer.destroyed ? 'closed' : peer.open ? 'open' : peer.disconnected ? 'disconnected' : 'connecting', clients: clients.size, ...extra });
  peer.on('open', () => notify());
  peer.on('disconnected', () => { notify(); if (!stopped) setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000); });
  peer.on('error', (e) => notify({ error: e.type }));
  peer.on('connection', (conn) => {
    const drop = () => { clients.delete(conn); notify(); };
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'hello') {
        if (d.pin !== pin) { try { conn.send({ t: 'denied' }); } catch {} setTimeout(() => conn.close(), 300); return; }
        conn.authed = true; clients.add(conn); conn.send({ t: 'state', s: getState() }); notify();
      } else if (conn.authed && d.t === 'cmd') { try { exec(d.c, d.a || {}); } catch (e) { console.error(e); } }
    });
    conn.on('close', drop); conn.on('error', drop);
  });
  const timer = setInterval(() => {
    if (!clients.size) return;
    const msg = JSON.stringify({ t: 'state', s: getState() });
    if (msg === last && ++idle < 25) return;            // unchanged: only a heartbeat every ~5 s
    idle = 0; last = msg;
    clients.forEach((c) => { try { c.send(JSON.parse(msg)); } catch {} });
  }, 200);
  return { stop() { stopped = true; clearInterval(timer); clients.forEach((c) => { try { c.close(); } catch {} }); peer.destroy(); }, get count() { return clients.size; } };
}
