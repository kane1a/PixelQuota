import avifEncoderFactory from '@jsquash/avif/codec/enc/avif_enc.js';
import avifWasm from '@jsquash/avif/codec/enc/avif_enc.wasm';
import { defaultOptions } from '@jsquash/avif/meta.js';

let encoderPromise = null;
let supportPromise = null;

function clampQuality(value) {
  return Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100)));
}

async function getEncoder() {
  if (!encoderPromise) {
    encoderPromise = avifEncoderFactory({
      noInitialRun:true,
      wasmBinary:avifWasm
    });
  }
  return encoderPromise;
}

export async function encodeAvif(canvas, quality=.9) {
  const context = canvas.getContext('2d', { willReadFrequently:true });
  if (!context) throw new Error('encode_failed:avif_canvas');
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const module = await getEncoder();
  const rgba = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
  const output = module.encode(rgba, imageData.width, imageData.height, {
    ...defaultOptions,
    quality:clampQuality(quality),
    qualityAlpha:-1,
    speed:8,
    bitDepth:8,
    lossless:false
  });
  if (!output) throw new Error('encode_failed:avif_no_data');
  return new Blob([output], { type:'image/avif' });
}

export function detectAvifEncoderSupport() {
  if (!supportPromise) {
    supportPromise = (async() => {
      try {
        if (typeof WebAssembly === 'undefined') return false;
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const context = canvas.getContext('2d');
        if (!context) return false;
        context.fillStyle = '#4f7cff';
        context.fillRect(0, 0, 2, 2);
        const blob = await encodeAvif(canvas, .8);
        const signature = new Uint8Array(await blob.slice(4, 12).arrayBuffer());
        return blob.type === 'image/avif' && String.fromCharCode(...signature) === 'ftypavif';
      } catch {
        return false;
      }
    })();
  }
  return supportPromise;
}
