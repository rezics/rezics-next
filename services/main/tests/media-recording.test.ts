import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { verifyRecording } from '../src/modules/media/recording.ts';
import { ImageFormatRejected } from '../src/modules/media/image.ts';

const wav = () => new Uint8Array(readFileSync(new URL('../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url)));
test('recording admission retains actual PCM duration and does not invent image dimensions', () => {
  const recording = verifyRecording(wav(), 'audio/wav');
  expect(recording).toMatchObject({ mediaType: 'audio/wav', width: 0, height: 0 });
  expect(recording.duration).toBeGreaterThan(1);
  expect(recording.duration).toBeLessThan(30);
});
test('recording container admission rejects type mismatch, truncated data and inconsistent frame alignment', () => {
  const bytes = wav();
  expect(() => verifyRecording(bytes, 'video/mp4')).toThrow(ImageFormatRejected);
  expect(() => verifyRecording(bytes.slice(0, -1), 'audio/wav')).toThrow(ImageFormatRejected);
  const invalid = bytes.slice(); new DataView(invalid.buffer).setUint16(32, 99, true);
  expect(() => verifyRecording(invalid, 'audio/wav')).toThrow(ImageFormatRejected);
  expect(() => verifyRecording(new Uint8Array([1, 2, 3]), 'audio/wav')).toThrow(ImageFormatRejected);
});
