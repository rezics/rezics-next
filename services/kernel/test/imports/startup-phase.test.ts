import { expect, test } from 'bun:test';
import { identityStallError } from './identity-fixture.ts';
import { mediaReachedPhase, mediaStallMessage } from './media-boundary-driver.ts';

test('identity stalls name the producer phase that was actually reached', () => {
  const error = identityStallError('auth-host-start', Date.now() - 40, new Error('listener refused'));
  expect(error.stalledPhase).toBe('auth-host-start');
  expect(error.phaseElapsedMs).toBeGreaterThanOrEqual(40);
  expect(error.message).toContain('Import identity stalled at auth-host-start');
  expect(error.message).toContain('listener refused');
  expect(error.message).not.toContain('password');
});

test('media stalls name the last MEDIA_START phase, not a hardcoded expected sequence', () => {
  expect(mediaReachedPhase('MEDIA_START workerHost\nMEDIA_START listen\nready later\n')).toBe('listen');
  expect(mediaReachedPhase('stdout without a start line\n')).toBeUndefined();
  const message = mediaStallMessage({
    reason: 'Media worker startup exceeded its fixture deadline',
    pid: 12,
    exit: null,
    signal: null,
    stdout: 'partial stdout',
    stderr: 'MEDIA_START workerHost\nMEDIA_START listen\n',
    startedAtMs: Date.now() - 25,
  });
  expect(message).toContain('stalledPhase=listen');
  expect(message).toContain('phaseElapsedMs=');
  expect(message).not.toContain('awaited MEDIA_READY');
});
