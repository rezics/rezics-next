import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { defaultPolicy } from './policy.ts';

export const SESSION_JSONL_READ_BUFFER_BYTES = defaultPolicy.records.sessionReadBufferBytes;
export const SESSION_JSONL_MAX_RECORD_BYTES = defaultPolicy.records.sessionRecordBytes;

export type SessionJsonlScan = {
  complete: boolean;
  bytesRead: number;
  maxRecordBytes: number;
  maxBufferedBytes: number;
};

/** Visit JSONL records with fixed-size reads and a bounded per-record buffer. */
export function scanSessionJsonl(
  path: string,
  visit: (event: Record<string, any>) => void,
  policy = defaultPolicy.records,
): SessionJsonlScan {
  const scan: SessionJsonlScan = { complete: true, bytesRead: 0, maxRecordBytes: 0, maxBufferedBytes: 0 };
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { ...scan, complete: false };
  }

  try {
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch {
      return { ...scan, complete: false };
    }
    const chunk = Buffer.alloc(policy.sessionReadBufferBytes);
    let position = 0;
    let line = '';
    let lineBytes = 0;
    let oversized = false;
    let firstLine = true;
    let decoder = new StringDecoder('utf8');

    const append = (bytes: Buffer) => {
      if (oversized || bytes.length === 0) return;
      if (lineBytes + bytes.length > policy.sessionRecordBytes) {
        oversized = true;
        line = '';
        lineBytes = 0;
        decoder = new StringDecoder('utf8');
        return;
      }
      lineBytes += bytes.length;
      scan.maxRecordBytes = Math.max(scan.maxRecordBytes, lineBytes);
      scan.maxBufferedBytes = Math.max(scan.maxBufferedBytes, policy.sessionReadBufferBytes + lineBytes);
      line += decoder.write(bytes);
    };

    const finishLine = () => {
      if (oversized) scan.complete = false;
      else if (lineBytes > 0) {
        let text = line + decoder.end();
        if (text.endsWith('\r')) text = text.slice(0, -1);
        if (firstLine && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        try {
          const event: unknown = JSON.parse(text);
          if (event === null || typeof event !== 'object' || Array.isArray(event)) scan.complete = false;
          else visit(event as Record<string, any>);
        } catch {
          scan.complete = false;
        }
      }
      firstLine = false;
      line = '';
      lineBytes = 0;
      oversized = false;
      decoder = new StringDecoder('utf8');
    };

    while (position < size) {
      const requested = Math.min(chunk.length, size - position);
      const count = readSync(fd, chunk, 0, requested, position);
      if (count <= 0) {
        scan.complete = false;
        break;
      }
      position += count;
      scan.bytesRead += count;
      let start = 0;
      for (let index = 0; index < count; index++) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(start, index));
        finishLine();
        start = index + 1;
      }
      append(chunk.subarray(start, count));
    }
    if (position === size && (lineBytes > 0 || oversized)) finishLine();
    return scan;
  } catch {
    return { ...scan, complete: false };
  } finally {
    closeSync(fd);
  }
}
