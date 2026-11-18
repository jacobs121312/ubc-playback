// Offline pitch-shift / time-stretch of one decoded buffer (SoundTouch, MPL-2.0, vendored in ./vendor/soundtouch)
import { SoundTouch } from './vendor/soundtouch/index.js';

self.onmessage = ({ data }) => {
  const { channels, sampleRate, semitones, tempo } = data;
  const n = channels[0].length, stereo = channels.length > 1;
  const st = new SoundTouch({ sampleRate });
  const p = Math.pow(2, semitones / 12);
  st.pitch = p;
  st.stretch.tempo = tempo / p;                  // net speed = stretch.tempo * rate(p) = tempo
  const outLen = Math.ceil(n / tempo) + 16384;
  const o0 = new Float32Array(outLen), o1 = stereo ? new Float32Array(outLen) : null;
  const CH = 4096, inb = new Float32Array(CH * 2), ob = new Float32Array(CH * 2);
  let w = 0;
  const drain = () => {
    while (st.outputBuffer.frameCount > 0) {
      const k = Math.min(CH, st.outputBuffer.frameCount);
      st.outputBuffer.extract(ob, 0, k, true);
      for (let i = 0; i < k && w + i < outLen; i++) { o0[w + i] = ob[2 * i]; if (o1) o1[w + i] = ob[2 * i + 1]; }
      w += k;
    }
  };
  for (let pos = 0; pos < n; pos += CH) {
    const m = Math.min(CH, n - pos);
    for (let i = 0; i < m; i++) { const l = channels[0][pos + i]; inb[2 * i] = l; inb[2 * i + 1] = stereo ? channels[1][pos + i] : l; }
    st.inputBuffer.putSamples(inb, 0, m); st.process(); drain();
  }
  inb.fill(0);
  for (let k = 0; k < 4; k++) { st.inputBuffer.putSamples(inb, 0, CH); st.process(); drain(); }
  const len = Math.min(w, Math.round(n / tempo));
  const out = [o0.slice(0, len)]; if (o1) out.push(o1.slice(0, len));
  self.postMessage({ channels: out }, out.map((c) => c.buffer));
};
