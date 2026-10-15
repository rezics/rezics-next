import { expect, test } from 'bun:test';
import { ACCOUNT_LIVE_RETENTION, CONTENT_LIVE_RETENTION, CONTENT_UPLOAD_RETENTION,
  GRAPH_COPY_RETENTION, GRAPH_LIVE_RETENTION, publicRetentionReason }
  from '../src/modules/erasure/retention-reasons.ts';

test('authored live, WAL and unverified copy reasons survive public reporting', () => {
  for (const reason of [ACCOUNT_LIVE_RETENTION, CONTENT_LIVE_RETENTION, CONTENT_UPLOAD_RETENTION,
    GRAPH_LIVE_RETENTION, ...Object.values(GRAPH_COPY_RETENTION)]) {
    expect(publicRetentionReason(reason)).toBe(reason);
  }
  expect(publicRetentionReason(null)).toBeNull();
});

test('private bases and text appended to an authored reason remain confidential', () => {
  for (const reason of ['Private retention case SAFETY-97', '',
    `${CONTENT_LIVE_RETENTION}; confidential hold`, `${GRAPH_COPY_RETENTION.backup}\ncase 42`]) {
    expect(publicRetentionReason(reason)).toBe('Copy destruction requires verification');
  }
});
