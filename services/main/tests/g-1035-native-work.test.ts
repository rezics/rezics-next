import { expect, test } from 'bun:test';
import { fusekiCommandWork } from '../../../packages/observability/src/http-measurement.ts';
import { summarizeWorkProfile, type WorkSpan } from '../../../tests/qa/support/work-profile.ts';

test('G1035: native command trace retains fixed numeric work and refuses arbitrary upstream data', () => {
  const attributes = fusekiCommandWork(
    new Headers({
      'server-timing':
        'jena;dur=21.5, commit;dur=20.125, validation;dur=1;desc="PRIVATE_VALUE", arbitrary;dur=7',
      'x-rezics-command-work':
        'current_adds=4,max_literal_bytes=79,revisions_literal_bytes=120,private_value=123',
    }),
  );
  expect(attributes).toEqual({
    'rezics.fuseki.validation_ms': 1,
    'rezics.fuseki.commit_ms': 20.125,
    'rezics.fuseki.current_adds': 4,
    'rezics.fuseki.revisions_literal_bytes': 120,
    'rezics.fuseki.max_literal_bytes': 79,
  });
  expect(JSON.stringify(attributes)).not.toContain('PRIVATE');
  expect(fusekiCommandWork(new Headers())).toEqual({});
  expect(
    fusekiCommandWork(
      new Headers({
        'server-timing': 'commit;dur=-1, validation;dur=NaN',
        'x-rezics-command-work': 'current_adds=9007199254740992,text_updates=-1',
      }),
    ),
  ).toEqual({});
});

test('G1035: compact work profiles retain native phase counters and keep unmeasured query work unknown', () => {
  const root: WorkSpan = {
    traceId: 'trace',
    spanId: 'server',
    parentSpanId: 'parent',
    service: 'main',
    name: 'request',
    kind: 1,
    startMs: 0,
    endMs: 25,
    attributes: { 'http.route': '/v1/works', 'http.response.status_code': 201 },
  };
  const command: WorkSpan = {
    ...root,
    spanId: 'command',
    parentSpanId: 'server',
    kind: 2,
    attributes: {
      'http.request.method': 'POST',
      'rezics.peer.service': 'fuseki',
      'rezics.fuseki.commit_ms': 20,
      'rezics.fuseki.text_adds': 0,
      'rezics.fuseki.validation_ms': 1,
      'rezics.fuseki.arbitrary': 'PRIVATE',
    },
  };
  const query: WorkSpan = {
    ...command,
    spanId: 'query',
    attributes: {
      'http.request.method': 'GET',
      'rezics.peer.service': 'fuseki',
    },
  };
  const profile = summarizeWorkProfile([root, command, query], 'trace', 'parent', 25, {
    service: 'main',
  });
  expect(profile.fusekiCalls[0]!.nativeWork).toEqual({
    validation_ms: 1,
    commit_ms: 20,
    text_adds: 0,
  });
  expect(profile.fusekiCalls[1]!.nativeWork).toBeNull();
  expect(JSON.stringify(profile.fusekiCalls)).not.toContain('PRIVATE');
});
