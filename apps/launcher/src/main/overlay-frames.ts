import { overlayFrameLimit, overlayPanelLimit, parseOverlayOutput } from '@rezics/launcher-contract';
import type { OverlayInput, OverlayOutput, Session } from '@rezics/launcher-contract';

export function encodeOverlaySession(session: Session, limit: number): string | undefined {
  const panels = session.panels?.slice(0, overlayPanelLimit).map((panel) => ({
    ...panel,
    title: panel.title.toWellFormed(),
    text: panel.text.toWellFormed(),
  }));
  const contents = { ...session, title: session.title.toWellFormed(), ...(panels && { panels }) };
  const encode = (snapshot: Session) =>
    JSON.stringify({ v: 1, type: 'session', session: snapshot } satisfies OverlayInput);
  let frame = encode(contents);
  if (Buffer.byteLength(frame) <= limit) return frame;

  const fitting: NonNullable<Session['panels']> = [];
  frame = encode({ ...contents, panels: fitting });
  if (Buffer.byteLength(frame) > limit) return;
  for (const panel of panels ?? []) {
    const candidate = encode({ ...contents, panels: [...fitting, panel] });
    if (Buffer.byteLength(candidate) <= limit) {
      fitting.push(panel);
      frame = candidate;
    }
  }
  return frame;
}

export function readOverlayFrames(receive: (frame: OverlayOutput) => void) {
  const buffer = Buffer.alloc(overlayFrameLimit);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let used = 0;
  let discard = false;

  return (chunk: Buffer): void => {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - start;
      if (used + size > buffer.length) discard = true;
      if (!discard) {
        chunk.copy(buffer, used, start, end);
        used += size;
      }
      if (newline === -1) return;
      const frame = discard ? undefined : parseFrame(decoder, buffer.subarray(0, used));
      used = 0;
      discard = false;
      start = newline + 1;
      if (frame) receive(frame);
    }
  };
}

function parseFrame(decoder: TextDecoder, bytes: Buffer): OverlayOutput | undefined {
  try {
    return parseOverlayOutput(decoder.decode(bytes));
  } catch {
    return;
  }
}
