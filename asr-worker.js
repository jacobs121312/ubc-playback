// Whisper (tiny.en, int8) in the browser via transformers.js; model is cached by the browser after the first download.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
env.allowLocalModels = false;
let asr = null;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      asr = await pipeline('automatic-speech-recognition', data.model || 'Xenova/whisper-tiny.en', {
        dtype: 'q8', device: 'wasm',
        progress_callback: (p) => { if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, pct: p.progress }); },
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'transcribe') {
      const r = await asr(data.audio, { chunk_length_s: 30 });
      self.postMessage({ type: 'text', id: data.id, text: r.text });
    }
  } catch (e) { self.postMessage({ type: 'error', id: data.id, message: String(e && e.message || e) }); }
};
