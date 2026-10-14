import { ImageFormatRejected } from './image.ts';

export interface VerifiedRecording { mediaType: 'audio/wav' | 'video/mp4'; width: number; height: number; duration: number }
const rejected = () => { throw new ImageFormatRejected('recording container is malformed or unsupported'); };
/** Container validation is bounded by upload bytes; it never invokes a decoder or fetches external media. */
export function verifyRecording(bytes: Uint8Array, declared: string): VerifiedRecording {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (declared === 'audio/wav') {
    if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) rejected();
    let rate = 0, alignment = 0, data = 0, format = false;
    let offset = 12;
    for (let chunks = 0; offset + 8 <= bytes.length && chunks < 4096; chunks++) {
      const size = view.getUint32(offset + 4, true), end = offset + 8 + size;
      if (end > bytes.length) rejected();
      if (tag(offset) === 'fmt ') {
        if (format || size < 16) rejected();
        const encoding = view.getUint16(offset + 8, true), channels = view.getUint16(offset + 10, true);
        rate = view.getUint32(offset + 12, true); alignment = view.getUint16(offset + 20, true);
        const bits = view.getUint16(offset + 22, true);
        if (![1, 3].includes(encoding) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000
          || ![8, 16, 24, 32, 64].includes(bits) || alignment !== channels * bits / 8
          || view.getUint32(offset + 16, true) !== rate * alignment) rejected();
        format = true;
      } else if (tag(offset) === 'data') { if (data) rejected(); data = size; }
      offset = end + size % 2;
    }
    if (offset !== bytes.length || !format || !data || data % alignment) rejected();
    return { mediaType: 'audio/wav', width: 0, height: 0, duration: data / alignment / rate };
  }
  if (declared !== 'video/mp4' || bytes.length < 32 || tag(4) !== 'ftyp') rejected();
  let duration = 0, width = 0, height = 0, media = false, boxes = 0;
  const walk = (start: number, end: number, depth: number) => {
    if (depth > 8) rejected();
    let offset = start;
    while (offset < end) {
      if (++boxes > 4096 || offset + 8 > end) rejected();
      let size = view.getUint32(offset), header = 8;
      if (size === 1) {
        if (offset + 16 > end) rejected();
        const large = view.getBigUint64(offset + 8); if (large > BigInt(bytes.length)) rejected();
        size = Number(large); header = 16;
      } else if (size === 0) size = end - offset;
      const next = offset + size, body = offset + header, kind = tag(offset + 4);
      if (size < header || next > end) rejected();
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) walk(body, next, depth + 1);
      else if (kind === 'mvhd') {
        const version = bytes[body];
        if (version === 0 && body + 20 <= next) {
          const scale = view.getUint32(body + 12); duration = scale ? view.getUint32(body + 16) / scale : 0;
        } else if (version === 1 && body + 32 <= next) {
          const scale = view.getUint32(body + 20); duration = scale ? Number(view.getBigUint64(body + 24)) / scale : 0;
        } else rejected();
      } else if (kind === 'tkhd') {
        if (next - body < 84) rejected();
        width = Math.max(width, view.getUint32(next - 8) / 65536);
        height = Math.max(height, view.getUint32(next - 4) / 65536);
      } else if (kind === 'mdat') media ||= next > body;
      offset = next;
    }
  };
  walk(0, bytes.length, 0);
  if (!media || !Number.isFinite(duration) || duration <= 0 || duration > 86400
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) rejected();
  return { mediaType: 'video/mp4', width, height, duration };
}
