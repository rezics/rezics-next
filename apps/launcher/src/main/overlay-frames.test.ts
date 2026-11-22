import { expect, test } from 'bun:test';
import { overlayFrameLimit, overlayPanelLimit, overlaySessionFrameLimit } from '@rezics/launcher-contract';
import type { OverlayOutput, Session } from '@rezics/launcher-contract';
import { encodeOverlaySession, readOverlayFrames } from './overlay-frames';

test('reads complete overlay actions across stream chunks and drops invalid frames', () => {
  const received: OverlayOutput[] = [];
  const read = readOverlayFrames((event) => received.push(event));
  read(Buffer.from('{"v":1,"type":"ready"}\n{"v":1,"type":"open-'));
  read(Buffer.from('destination","sessionId":"a","destination":"info"}\n{"v":2,"type":"ready"}\n'));
  read(Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.alloc(overlayFrameLimit, 65)]));
  read(Buffer.from('x\n{"v":1,"type":"ready","sessionFrameLimit":32768}\n'));
  read(Buffer.from('{"v":1,"type":"ready","sessionFrameLimit":65536}\n'));
  expect(received).toEqual([
    { v: 1, type: 'ready' },
    { v: 1, type: 'open-destination', sessionId: 'a', destination: 'info' },
    { v: 1, type: 'ready', sessionFrameLimit: overlaySessionFrameLimit },
    { v: 1, type: 'ready' },
  ]);
});

test('keeps full large panel snapshots for a capable Overlay and keeps fitting panels for a legacy sidecar', () => {
  const large = '\x01'.repeat(400);
  const panels = Array.from({ length: overlayPanelLimit }, (_, index) => ({
    id: `fixture.panel-${index}`,
    title: `Panel ${index}`,
    text: index === overlayPanelLimit - 1 ? 'Final \ud800 panel' : large,
    destination: 'guide' as const,
  }));
  const session: Session = {
    sessionId: 'running',
    instanceId: 'fixture',
    pid: 1,
    title: 'Game \ud800',
    startedAt: 123,
    destinations: [{ id: 'guide', label: 'Guide' }],
    panels,
  };
  const sanitized: Session = {
    ...session,
    title: 'Game \ufffd',
    panels: [...panels.slice(0, -1), { ...panels.at(-1)!, text: 'Final \ufffd panel' }],
  };
  const full = encodeOverlaySession(session, overlaySessionFrameLimit)!;
  expect(Buffer.byteLength(full)).toBeGreaterThan(overlayFrameLimit);
  expect(JSON.parse(full)).toEqual({ v: 1, type: 'session', session: sanitized });

  const legacy = encodeOverlaySession(session, overlayFrameLimit)!;
  expect(Buffer.byteLength(legacy)).toBeLessThanOrEqual(overlayFrameLimit);
  expect(JSON.parse(legacy).session).toEqual({
    ...sanitized,
    panels: [...panels.slice(0, 6), sanitized.panels!.at(-1)],
  });
  expect(
    encodeOverlaySession({ ...session, title: '文'.repeat(overlayFrameLimit) }, overlayFrameLimit),
  ).toBeUndefined();
});
