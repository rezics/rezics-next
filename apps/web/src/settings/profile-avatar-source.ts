import { avatarCropSourceSupported, type AvatarCropSource } from './profile-avatar-crop.ts';

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const supportedJpegFrames = new Set([0xc0, 0xc1, 0xc2]);
const avatarCropHeaderLimit = 256 * 1024;

/** Read only a bounded encoded prefix to decide whether local crop decoding is safe. */
export async function readAvatarCropSource(file: File): Promise<AvatarCropSource | null> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return null;
  try {
    const expectedBytes = Math.min(file.size, avatarCropHeaderLimit);
    const buffer = await file.slice(0, avatarCropHeaderLimit).arrayBuffer();
    if (buffer.byteLength !== expectedBytes) return null;
    const bytes = new Uint8Array(buffer);
    const source = file.type === 'image/png' ? readPngSource(bytes) : readJpegSource(bytes);
    return source && avatarCropSourceSupported(source) ? source : null;
  } catch {
    return null;
  }
}

function readPngSource(bytes: Uint8Array): AvatarCropSource | null {
  if (bytes.byteLength < pngSignature.length) return null;
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (bytes[index] !== pngSignature[index]) return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = pngSignature.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let seenPalette = false;

  while (offset <= bytes.byteLength - 12) {
    const length = view.getUint32(offset, false);
    const dataOffset = offset + 8;
    if (length > bytes.byteLength - offset - 12) return null;
    const typeOffset = offset + 4;
    const type = String.fromCharCode(
      bytes[typeOffset]!,
      bytes[typeOffset + 1]!,
      bytes[typeOffset + 2]!,
      bytes[typeOffset + 3]!,
    );
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[typeOffset + 2]! & 0x20) !== 0) return null;

    if (offset === pngSignature.length) {
      if (type !== 'IHDR' || length !== 13) return null;
      width = view.getUint32(dataOffset, false);
      height = view.getUint32(dataOffset + 4, false);
      const bitDepth = bytes[dataOffset + 8]!;
      colorType = bytes[dataOffset + 9]!;
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        (colorType === 4 && [8, 16].includes(bitDepth)) ||
        (colorType === 6 && [8, 16].includes(bitDepth));
      if (
        width < 1 ||
        height < 1 ||
        !validDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12]! > 1 ||
        readUint32(bytes, dataOffset + length) !== pngCrc32(bytes, typeOffset, 4 + length)
      )
        return null;
    } else if (type === 'IHDR') return null;

    if (type === 'acTL') {
      if (length !== 8 || view.getUint32(dataOffset, false) < 1) return null;
      return null;
    }
    if (type === 'PLTE') {
      if (seenPalette || length < 3 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4)
        return null;
      seenPalette = true;
    } else if (isPngCriticalChunk(type) && type !== 'IHDR' && type !== 'IDAT') return null;

    const next = offset + 12 + length;
    if (type === 'IDAT') {
      if (length === 0 || (colorType === 3 && !seenPalette)) return null;
      return { width, height };
    }
    if (type === 'IEND') return null;
    offset = next;
  }

  return null;
}

function isPngCriticalChunk(type: string): boolean {
  return type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
}

function readJpegSource(bytes: Uint8Array): AvatarCropSource | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let frame: { source: AvatarCropSource; components: number[] } | undefined;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset++]!;

    if (marker === 0x01) continue;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (marker === 0xde || marker === 0xdf) return null;

    if (offset > bytes.byteLength - 2) return null;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || segmentLength > bytes.byteLength - offset) return null;
    const dataOffset = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (marker === 0xda) {
      if (!frame) return null;
      const scanComponents = bytes[dataOffset];
      if (
        scanComponents === undefined ||
        scanComponents < 1 ||
        scanComponents > frame.components.length ||
        segmentLength !== 6 + 2 * scanComponents
      )
        return null;
      const seen = new Set<number>();
      for (let index = 0; index < scanComponents; index += 1) {
        const component = bytes[dataOffset + 1 + 2 * index]!;
        if (!frame.components.includes(component) || seen.has(component)) return null;
        seen.add(component);
      }
      return frame.source;
    }

    if (isJpegFrameMarker(marker)) {
      if (frame || !supportedJpegFrames.has(marker) || segmentLength < 11) return null;
      const precision = bytes[dataOffset]!;
      const height = view.getUint16(dataOffset + 1, false);
      const width = view.getUint16(dataOffset + 3, false);
      const componentCount = bytes[dataOffset + 5]!;
      if (
        componentCount < 1 ||
        componentCount > 4 ||
        segmentLength !== 8 + 3 * componentCount ||
        width < 1 ||
        height < 1 ||
        (marker === 0xc0 ? precision !== 8 : precision !== 8 && precision !== 12)
      )
        return null;
      const components: number[] = [];
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = dataOffset + 6 + 3 * index;
        const id = bytes[componentOffset]!;
        const sampling = bytes[componentOffset + 1]!;
        const quantizationTable = bytes[componentOffset + 2]!;
        const horizontalSampling = sampling >> 4;
        const verticalSampling = sampling & 0x0f;
        if (
          components.includes(id) ||
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          quantizationTable > 3
        )
          return null;
        components.push(id);
      }
      frame = { source: { width, height }, components };
    } else if (!isSupportedJpegSegment(marker)) return null;

    offset = segmentEnd;
  }

  return null;
}

function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isSupportedJpegSegment(marker: number): boolean {
  return marker === 0xc4 || marker === 0xdb || marker === 0xdd || (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function pngCrc32(bytes: Uint8Array, offset: number, length: number): number {
  let crc = 0xffffffff;
  const end = offset + length;
  for (let index = offset; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
