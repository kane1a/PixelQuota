const MODEL_ORIGIN = 'https://huggingface.co';
const MODEL_BASE = '/studioludens/birefnet-lite-512/resolve/main';
const ALLOWED_MODEL_PATHS = new Set([
  `${MODEL_BASE}/config.json`,
  `${MODEL_BASE}/preprocessor_config.json`,
  `${MODEL_BASE}/onnx/model_fp16.onnx`,
]);

export const MODEL_WEIGHT_RESOURCE_URL = `${MODEL_ORIGIN}${MODEL_BASE}/onnx/model_fp16.onnx`;

function inputUrl(input) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method === 'GET' ? input.url : null;
  return null;
}

export function getAllowedModelResourceUrl(input) {
  const value = inputUrl(input);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== MODEL_ORIGIN || url.username || url.password) return null;
    if (url.search || url.hash || value.includes('?') || value.includes('#') || !ALLOWED_MODEL_PATHS.has(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isAllowedModelResourceUrl(input) {
  return getAllowedModelResourceUrl(input) !== null;
}

export function isModelWeightResourceUrl(input) {
  return getAllowedModelResourceUrl(input) === MODEL_WEIGHT_RESOURCE_URL;
}

export function isCompleteSuccessfulResponse(response, bodySize) {
  if (!response || response.status !== 200 || response.body === null || response.bodyUsed) return false;
  const headers = response.headers;
  if (headers?.has?.('content-range')) return false;
  if (bodySize !== undefined && (!Number.isSafeInteger(bodySize) || bodySize <= 0)) return false;
  const rawLength = headers?.get?.('content-length');
  if (rawLength !== null && rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength)) return false;
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return false;
    const encoding = headers.get('content-encoding');
    if (bodySize !== undefined && contentLength !== bodySize && (!encoding || encoding.toLowerCase() === 'identity')) return false;
  }
  return true;
}

export function shouldRetainModelCacheRecord(record) {
  if (!record || typeof record.url !== 'string' || !isAllowedModelResourceUrl(record.url)) return false;
  if (typeof Blob === 'undefined' || !(record.blob instanceof Blob) || record.blob.size <= 0) return false;
  try {
    const response = new Response(record.blob, {
      status: record.status,
      statusText: record.statusText || 'OK',
      headers: record.headers || {},
    });
    return isCompleteSuccessfulResponse(response, record.blob.size);
  } catch {
    return false;
  }
}
