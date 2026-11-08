// Runs the embedding model (bge-small-en-v1.5, CLS pooling) off the main thread.
// Downloaded once and cached by the browser.
//
// GPU (WebGPU) when available: ~20x faster for indexing a whole textbook. GPUs recompile
// for every new input shape, so inputs are padded to a few fixed lengths and a fixed batch
// size; otherwise variable-length passages make the GPU slower than it should be.
// CPU fallback uses the quantised model (~34 MB). Vectors from both match (cosine ~0.997),
// so a book indexed on a laptop GPU is searchable from a phone on CPU.
import { AutoTokenizer, AutoModel, env } from '@huggingface/transformers';

env.allowLocalModels = false;
// Passages are embedded from their first ~160 tokens (heading + roughly 120 words): enough to
// capture what a passage is about, and attention cost grows steeply with length (on a laptop
// GPU 512 tokens is ~10x slower than 128). Keyword search still covers the full text.
const MAX_TOKENS = 160;
const BUCKETS = [64, 112, 160];
const GPU_BATCH = 32;
let loaded = null;

async function hasWebGPU() {
  try { return !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; }
}

function load(modelId, cpuOnly) {
  if (loaded) return loaded;
  loaded = (async () => {
    const progress_callback = (p) => self.postMessage({ type: 'progress', p });
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
    if (!cpuOnly && (await hasWebGPU())) {
      try {
        const model = await AutoModel.from_pretrained(modelId, { device: 'webgpu', dtype: 'fp32', progress_callback });
        return { tokenizer, model, device: 'webgpu' };
      } catch (e) { console.warn('WebGPU unavailable, using CPU', e); }
    }
    const model = await AutoModel.from_pretrained(modelId, { dtype: 'q8', progress_callback });
    return { tokenizer, model, device: 'wasm' };
  })();
  return loaded;
}

async function embedBatch({ tokenizer, model, device }, texts) {
  let input = texts;
  let enc;
  if (device === 'webgpu') {
    // Fixed shapes: pad the batch to GPU_BATCH rows and the length to a bucket.
    const probe = tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS });
    const len = probe.input_ids.dims[1];
    const bucket = BUCKETS.find((b) => b >= len) || MAX_TOKENS;
    input = texts.concat(Array(Math.max(0, GPU_BATCH - texts.length)).fill(''));
    enc = tokenizer(input, { padding: 'max_length', truncation: true, max_length: bucket });
  } else {
    enc = tokenizer(input, { padding: true, truncation: true, max_length: MAX_TOKENS });
  }
  const { last_hidden_state: h } = await model(enc);
  const [, L, D] = h.dims;
  const data = h.data;
  return texts.map((_, i) => {
    const v = Float32Array.from(data.subarray(i * L * D, i * L * D + D)); // CLS token
    let n = 0;
    for (let k = 0; k < D; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < D; k++) v[k] /= n;
    return v;
  });
}

self.onmessage = async ({ data }) => {
  const { id, model, texts, cpuOnly } = data;
  try {
    const m = await load(model, cpuOnly);
    const step = m.device === 'webgpu' ? GPU_BATCH : 16;
    const vectors = [];
    for (let i = 0; i < texts.length; i += step) vectors.push(...(await embedBatch(m, texts.slice(i, i + step))));
    self.postMessage({ id, type: 'result', vectors, device: m.device }, vectors.map((v) => v.buffer));
  } catch (e) {
    self.postMessage({ id, type: 'error', error: String(e?.message || e) });
  }
};
