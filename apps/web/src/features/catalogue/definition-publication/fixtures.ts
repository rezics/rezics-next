import { closedPublicationOperations, grantedPublicationOperations } from '@rezics/definitions';
import type {
  CatalogueBuildStatus,
  PublicationPreview,
  PublicationRead,
  PublicationTransport,
} from './model';

export type PublicationScenario =
  | 'review'
  | 'build'
  | 'reconciliation'
  | 'completed'
  | 'closed'
  | 'denied'
  | 'invalid'
  | 'uncertain';

const digest = `sha256:${'ab'.repeat(32)}`;
const previous = `sha256:${'cd'.repeat(32)}`;
const operations = grantedPublicationOperations();

function preview(kind: PublicationPreview['kind'] = 'release'): PublicationPreview {
  return {
    kind,
    identity: { digest, version: '1.1.0', format: 'https://rezics.com/definitions/release/1' },
    diagnostics: [],
    comparison: {
      addedTypes: ['ex:BoardGame'],
      removedTypes: [],
      changedTypes: [],
      addedProperties: ['ex:playerCount'],
      removedProperties: [],
      changedProperties: [],
    },
    types: [{ id: 'ex:BoardGame' }],
    current: { digest: previous, head: 4 },
    reconciliation: { intended: digest, current: { digest: previous, head: 4 }, stale: false },
    operations,
    document: {
      format: 'https://rezics.com/definitions/release/1',
      types: { 'ex:BoardGame': { labels: { en: 'Board game' }, properties: [] } },
      properties: {},
    },
  };
}

function buildStatus(state: CatalogueBuildStatus['state'] = 'building'): CatalogueBuildStatus {
  return {
    pin: { rootDigest: digest },
    state,
    phase: 'release',
    steps: '12',
    missing_digest: null,
    error: null,
  };
}

export function definitionPublicationFixture(scenario: PublicationScenario = 'review'): {
  initial: PublicationRead;
  preview: PublicationPreview;
  build: CatalogueBuildStatus | null;
  transport: PublicationTransport;
} {
  const closed: PublicationRead = { ok: true, phase: 'closed', scope: 'platform', operations: closedPublicationOperations(), current: null };
  const ready: PublicationRead = {
    ok: true,
    phase: 'idle',
    scope: 'platform',
    operations,
    current: { digest: previous, head: 4 },
  };
  const denied: PublicationRead = { ok: false, reason: scenario === 'denied' ? 'denied' : 'closed' };
  const document = { format: 'https://rezics.com/definitions/release/1', types: { 'ex:BoardGame': { labels: { en: 'Board game' }, properties: [] } }, properties: {} };
  let calls = 0;
  const transport: PublicationTransport = {
    open: async () => (scenario === 'closed' || scenario === 'denied' ? (scenario === 'denied' ? denied : closed) : ready),
    preview: async () => {
      if (scenario === 'invalid')
        return {
          ...preview(),
          kind: 'invalid',
          identity: null,
          diagnostics: [{ pointer: '/release/types/ex:BoardGame/labels/en', code: 'required', file: null }],
        };
      return preview();
    },
    submit: async (command) => {
      calls += 1;
      if (scenario === 'uncertain' && calls === 1) return { ok: false, reason: 'uncertain' };
      if (scenario === 'reconciliation' && command.operation === 'activate' && calls === 1)
        return { ok: false, reason: 'stale', expectedHead: 5 };
      if (command.operation === 'step' || command.operation === 'build')
        return { ok: true, status: 200, result: { digest, pin: { rootDigest: digest } } };
      if (command.operation === 'activate') return { ok: true, status: 200, result: { digest, head: 5 } };
      return { ok: true, status: 201, result: { digest } };
    },
    readRelease: async (value) => ({ ok: true, digest: value }),
    readExtension: async (_context, value) => ({ ok: true, digest: value }),
    readBuild: async () => (scenario === 'build' ? buildStatus() : { ok: false, reason: 'missing' }),
    createSubject: async () => ({ ok: true, id: '019a1b2c-3d4e-7f00-8a00-def000000001' }),
    readSubject: async (id) => ({ ok: true, id, type: 'ex:BoardGame' }),
  };
  void document;
  return {
    initial: scenario === 'closed' ? closed : scenario === 'denied' ? denied : ready,
    preview: preview(),
    build: scenario === 'build' ? buildStatus() : null,
    transport,
  };
}
