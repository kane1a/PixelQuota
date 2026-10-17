import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedModelResourceUrl,
  isModelWeightResourceUrl,
  isCompleteSuccessfulResponse,
  shouldRetainModelCacheRecord,
} from '../src/model-cache-policy.js';

const MODEL = 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/main';
const WEIGHT = `${MODEL}/onnx/model_fp16.onnx`;
const ALLOWED = [
  `${MODEL}/config.json`,
  `${MODEL}/preprocessor_config.json`,
  WEIGHT,
];

test('permits only the three exact HTTPS resources for the current model', () => {
  for (const url of ALLOWED) assert.equal(isAllowedModelResourceUrl(url), true, url);
  assert.equal(isAllowedModelResourceUrl(new URL(WEIGHT)), true);
  assert.equal(isAllowedModelResourceUrl(new Request(WEIGHT)), true);
  assert.equal(isAllowedModelResourceUrl(new Request(WEIGHT, { method: 'POST' })), false);
  assert.equal(isAllowedModelResourceUrl(new Request(WEIGHT, { method: 'HEAD' })), false);
});

test('rejects lookalike hosts, paths, query strings, other protocols and unrelated assets', () => {
  const rejected = [
    'http://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
    'https://evil.example/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
    'https://huggingface.co.evil.example/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
    'https://user@huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
    'https://huggingface.co:8443/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
    'https://huggingface.co/studioludens/birefnet-lite-512-evil/resolve/main/onnx/model_fp16.onnx',
    `${WEIGHT}?download=1`,
    `${WEIGHT}?`,
    `${WEIGHT}#fragment`,
    `${WEIGHT}#`,
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm',
    `${MODEL}/onnx/model_fp16.onnx.wasm`,
    `${MODEL}/onnx/vocab.json`,
    `${MODEL}/image.png`,
    'data:application/octet-stream,model',
  ];
  for (const url of rejected) assert.equal(isAllowedModelResourceUrl(url), false, url);
  assert.equal(isAllowedModelResourceUrl({ url: WEIGHT }), false);
});

test('recognizes only the exact full model-weight URL as the weight resource', () => {
  assert.equal(isModelWeightResourceUrl(WEIGHT), true);
  assert.equal(isModelWeightResourceUrl(new Request(WEIGHT)), true);
  for (const url of [...ALLOWED.slice(0, 2), `${WEIGHT}?download=1`, 'https://evil.example/onnx/model_fp16.onnx']) {
    assert.equal(isModelWeightResourceUrl(url), false, url);
  }
});

test('accepts complete 200 responses and rejects failures, ranges, empty and length-mismatched bodies', () => {
  assert.equal(isCompleteSuccessfulResponse(new Response('model', { status: 200 }), 5), true);
  assert.equal(isCompleteSuccessfulResponse(new Response('no', { status: 404 }), 2), false);
  assert.equal(isCompleteSuccessfulResponse(new Response('part', {
    status: 206,
    headers: { 'content-range': 'bytes 0-3/8', 'content-length': '4' },
  }), 4), false);
  assert.equal(isCompleteSuccessfulResponse(new Response('model', {
    status: 200,
    headers: { 'content-range': 'bytes 0-4/8' },
  }), 5), false);
  assert.equal(isCompleteSuccessfulResponse(new Response('short', {
    status: 200,
    headers: { 'content-length': '10' },
  }), 5), false);
  assert.equal(isCompleteSuccessfulResponse(new Response('decoded body', {
    status: 200,
    headers: { 'content-length': '20', 'content-encoding': 'gzip' },
  }), 12), true);
  assert.equal(isCompleteSuccessfulResponse(new Response('', { status: 200 }), 0), false);
  assert.equal(isCompleteSuccessfulResponse(new Response(null, { status: 200 }), 0), false);
});

test('migration retains only complete exact model records, including the full ONNX weights', () => {
  const modelRecord = url => ({ url, blob: new Blob(['complete model bytes']), status: 200, headers: {} });
  assert.equal(shouldRetainModelCacheRecord(modelRecord(WEIGHT)), true);
  assert.equal(shouldRetainModelCacheRecord(modelRecord(ALLOWED[0])), true);
  assert.equal(shouldRetainModelCacheRecord({
    ...modelRecord(WEIGHT),
    status: 206,
    headers: { 'content-range': 'bytes 0-3/8' },
  }), false);
  assert.equal(shouldRetainModelCacheRecord({
    ...modelRecord(WEIGHT),
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/ort.wasm',
  }), false);
  assert.equal(shouldRetainModelCacheRecord({
    ...modelRecord(WEIGHT),
    url: 'https://evil.example/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx',
  }), false);
  assert.equal(shouldRetainModelCacheRecord({ ...modelRecord(WEIGHT), blob: new Blob([]) }), false);
});

console.log('model-cache-policy: policy regression cases passed');
