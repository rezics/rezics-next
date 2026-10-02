import { SCREEN_LIMITS, SCREEN_POLICY, screenVerdict, type Scores } from '@rezics/main/image-screen-policy';
import type { NSFWJS } from 'nsfwjs/core';

export interface ClientImageInference {
  model: string; modelVersion: string; weightsDigest: string; policyVersion: string;
  status: 'completed' | 'unavailable'; result: 'sfw' | 'nsfw' | 'unknown'; scores?: Scores;
}
const provenance = { model: SCREEN_POLICY.model, modelVersion: SCREEN_POLICY.version,
  weightsDigest: SCREEN_POLICY.weightsDigest, policyVersion: 'image-nsfw-v1' };
const unavailable = (): ClientImageInference => ({ ...provenance, status: 'unavailable', result: 'unknown' });
let model: Promise<NSFWJS> | undefined;
let tail = Promise.resolve();
let queued = 0;
const cache = new Map<string, Promise<ClientImageInference>>();

function loadModel(): Promise<NSFWJS> {
  model ??= Promise.all([import('nsfwjs/core'), import('nsfwjs/models/mobilenet_v2')])
    .then(async ([{ load }, { MobileNetV2Model }]) => {
      const bundles = await Promise.all(MobileNetV2Model.weightBundles.map(async bundle => Uint8Array.from(atob((await bundle()).default), char => char.charCodeAt(0))));
      const bytes = new Uint8Array(bundles.reduce((total, bundle) => total + bundle.length, 0));
      let offset = 0;
      for (const bundle of bundles) { bytes.set(bundle, offset); offset += bundle.length; }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== SCREEN_POLICY.weightsDigest) throw new Error('image-model-integrity');
      return load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] });
    })
    .catch(error => { model = undefined; throw error; });
  return model;
}

/** One bounded inference worker per browser; model loading and result reuse happen only on upload. */
export function classifyImage(image: Blob, sha256: string): Promise<ClientImageInference> {
  const existing = cache.get(sha256);
  if (existing) return existing;
  if (queued >= 4 || typeof createImageBitmap !== 'function' || image.size > SCREEN_LIMITS.bytes) return Promise.resolve(unavailable());
  queued++;
  const run = tail.then(async () => {
    const bitmap = await createImageBitmap(image, { resizeWidth: SCREEN_LIMITS.inputSize, resizeHeight: SCREEN_LIMITS.inputSize });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SCREEN_LIMITS.inputSize; canvas.height = SCREEN_LIMITS.inputSize;
      const context = canvas.getContext('2d');
      if (!context) return unavailable();
      context.drawImage(bitmap, 0, 0);
      const classifier = await loadModel();
      const predictions = await classifier.classify(canvas, 5);
      const scores = Object.fromEntries(predictions.map(prediction => [prediction.className, prediction.probability])) as Scores;
      // This produces a label observation. It never grants or refuses media clearance.
      return { ...provenance, status: 'completed' as const, result: screenVerdict(scores).clearance === 'held' ? 'nsfw' as const : 'sfw' as const, scores };
    } finally { bitmap.close(); }
  }).catch(unavailable);
  tail = run.then(() => { queued--; });
  const result = new Promise<ClientImageInference>(resolve => {
    const timeout = setTimeout(() => resolve(unavailable()), SCREEN_LIMITS.timeoutMs);
    void run.then(value => { clearTimeout(timeout); resolve(value); });
  });
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(sha256, result);
  return result;
}
