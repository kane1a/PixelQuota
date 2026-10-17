import avifEncoderFactory from '@jsquash/avif/codec/enc/avif_enc.js';
import avifWasm from '@jsquash/avif/codec/enc/avif_enc.wasm';
import { defaultOptions } from '@jsquash/avif/meta.js';

export { avifEncoderFactory, avifWasm, defaultOptions };

export async function loadAvifWasm(){
  if(typeof avifWasm!=='string')return avifWasm;
  const response=await fetch(new URL(avifWasm,import.meta.url),{cache:'no-store'});
  if(!response.ok)throw new Error(`encode_failed:avif_wasm_http_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
