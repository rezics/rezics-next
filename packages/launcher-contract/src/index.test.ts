import { expect, test } from 'bun:test';
import { isEarlierMinecraftRelease, overlayFrameLimit, parseOverlayOutput } from './index';

test('orders exact Minecraft releases numerically across both naming schemes', () => {
  expect(isEarlierMinecraftRelease('1.21.9', '1.21.11')).toBe(true);
  expect(isEarlierMinecraftRelease('1.21.11', '26.1')).toBe(true);
  expect(isEarlierMinecraftRelease('26.3', '26.3.1')).toBe(true);
  expect(isEarlierMinecraftRelease('26.10', '26.3')).toBe(false);
  expect(isEarlierMinecraftRelease('26.3', '26.3.0')).toBe(false);
  expect(isEarlierMinecraftRelease('26.4-snapshot-1', '26.4')).toBe(false);
});

test('accepts only versioned Overlay lifecycle and destination actions within the byte limit', () => {
  const ready = { v: 1, type: 'ready' } as const;
  const guide = { v: 1, type: 'open-destination', sessionId: 'fixture', destination: 'guide' } as const;
  expect(parseOverlayOutput(JSON.stringify(ready))).toEqual(ready);
  const alternate = { ...ready, shortcut: 'ctrl-shift-f10' } as const;
  expect(parseOverlayOutput(JSON.stringify(alternate))).toEqual(alternate);
  expect(parseOverlayOutput(JSON.stringify({ ...ready, shortcut: 'ctrl-shift-f12' }))).toBeUndefined();
  expect(parseOverlayOutput('{"type":"hotkey-unavailable","v":1}')).toEqual({ type: 'hotkey-unavailable', v: 1 });
  expect(parseOverlayOutput('{"type":"webview2-unavailable","v":1}')).toEqual({ type: 'webview2-unavailable', v: 1 });
  expect(parseOverlayOutput('{"type":"webview2-unavailable","v":1,"runtimeDetected":true}')).toEqual({
    type: 'webview2-unavailable',
    v: 1,
    runtimeDetected: true,
  });
  const attachment = { v: 1, type: 'session-status', sessionId: 'fixture', attached: false } as const;
  expect(parseOverlayOutput(JSON.stringify(attachment))).toEqual(attachment);
  expect(parseOverlayOutput(JSON.stringify({ ...attachment, attached: 'false' }))).toBeUndefined();
  expect(parseOverlayOutput(JSON.stringify({ ...attachment, sessionId: ' ' }))).toBeUndefined();
  expect(parseOverlayOutput(JSON.stringify(guide))).toEqual(guide);
  expect(parseOverlayOutput(JSON.stringify({ ...guide, destination: 'https://example.invalid' }))).toBeUndefined();
  expect(parseOverlayOutput(JSON.stringify({ ...guide, v: 2 }))).toBeUndefined();
  expect(
    parseOverlayOutput(JSON.stringify({ ...guide, sessionId: '文'.repeat(overlayFrameLimit / 2) })),
  ).toBeUndefined();
  expect(parseOverlayOutput('{')).toBeUndefined();
});
