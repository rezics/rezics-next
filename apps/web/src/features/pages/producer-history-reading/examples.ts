import { producerHistoryFixture } from '../../../kernel/fake/producer-history';
import { candidateContext } from '../visit-host-port';
import {
  relationFields,
  type RelationProposal,
  type RelationRead,
  type RelationTransport,
} from '../../../subject/relation-candidates';
import type { ProducerHistoryRead } from '../../catalogue/producer-history';
import type { ProducerHistoryTransport } from '../producer-history';

export type RecoveryExample = 'later' | 'failed' | 'retired';

/** Authored response seam for the mounted reader/editor, without native or rendered proof. */
export function producerRecoveryExample(scenario: RecoveryExample = 'later', locale = 'en') {
  const fixture = producerHistoryFixture('partial', locale);
  const first = fixture.snapshot();
  if (!first.ok) throw new Error('Expected producer example');
  first.rows = first.rows.slice(0, 1);
  const proposals: RelationProposal[] = [];
  const reads: { stream: string | undefined; cursor: string | undefined; session: string | undefined }[] = [];
  let failed = false;
  const descriptor = {
    typeId: fixture.studio.subject.type,
    releaseDigest: fixture.studio.subject.release,
    definition: fixture.release.types[fixture.studio.subject.type]!,
    properties: fixture.release.properties,
  };
  const relationRead: RelationRead = {
    ok: true,
    viewer: 'signed-in',
    public: fixture.studio,
    descriptor,
    fields: relationFields(descriptor, locale),
    names: Object.fromEntries(Object.entries(descriptor.properties).map(([id, property]) => [id, property.labels])),
    page: null,
    authority: {
      disclosure: 'available',
      actions: { state: 'available', context: candidateContext, operations: ['subject.propose'] },
    },
    ...(first.session ? { session: first.session } : {}),
  };
  const relation: RelationTransport = {
    read: async () => relationRead,
    propose: async (input) => {
      proposals.push(structuredClone(input));
      return { ok: false, reason: 'unavailable' };
    },
    confirm: async () => ({ ok: false, reason: 'unavailable' }),
  };
  const transport: ProducerHistoryTransport = {
    read: async (stream, cursor, session): Promise<ProducerHistoryRead> => {
      reads.push({ stream, cursor, session });
      if (cursor && scenario !== 'later' && (!failed || scenario === 'retired')) {
        failed = true;
        return { ok: false, reason: 'unavailable' };
      }
      return fixture.transport.read(stream, cursor, session);
    },
    relation: () => relation,
  };
  return { fixture, first, transport, relation, relationRead, reads, proposals };
}
