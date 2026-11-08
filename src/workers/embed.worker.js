// Runs the embedding model off the main thread. The quantised model (~34 MB) is
// downloaded once from the Hugging Face hub and cached by the browser.
// The same quantised model is used on every device so book and query vectors match.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
let extractor = null;

async function load(model) {
  if (!extractor) {
    extractor = pipeline('feature-extraction', model, {
      dtype: 'q8',
      progress_callback: (p) => self.postMessage({ type: 'progress', p }),
    });
  }
  return extractor;
}

self.onmessage = async ({ data }) => {
  const { id, model, texts } = data;
  try {
    const ex = await load(model);
    const out = await ex(texts, { pooling: 'cls', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const vectors = texts.map((_, i) => Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
    self.postMessage({ id, type: 'result', vectors }, vectors.map((v) => v.buffer));
  } catch (e) {
    self.postMessage({ id, type: 'error', error: String(e?.message || e) });
  }
};
