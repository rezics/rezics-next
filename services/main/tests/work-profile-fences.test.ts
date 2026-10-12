import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { WorkReadSession, WorkReadMoved } from '../src/modules/work/read-session.ts';
import { readWorkBasis } from '../src/modules/work/read-header.ts';
import { serialId } from './serial-selected-fixture.ts';

function fixture() {
  const first = serialId(1), second = serialId(2);
  const profiles = { 'work-metadata-v1': 'a'.repeat(64), 'work-metadata-details-v1': 'b'.repeat(64), unrelated: 'c'.repeat(64) };
  const term = (value: string) => ({ type: 'uri', value });
  const graph = new FusekiClient('http://graph.invalid/profiles');
  graph.commandHealth = async () => ({ profiles }) as never;
  graph.query = async query => ({ results: { bindings: query.includes('SELECT ?head ?main ?mainHead')
    ? [{ head: term(serialId(3)), main: term(serialId(4)), mainHead: term(serialId(5)), public: term('true'),
      ...(query.includes(`<${second}>`) ? { metadataHead: term(serialId(6)) } : {}) }]
    : query.includes('SELECT ?state') ? [{ state: { type: 'literal', value: JSON.stringify({ kind: 'header', originalTitle: null, localized: [] }) } }]
    : [] } });
  const deps = { environment: { fuseki: graph } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/'), {}, { dataEpoch: 'epoch', sequence: '1' });
  session.summaries = async works => works.map(work => ({ id: work, status: 'available', type: 'work',
    name: null, avatar: null } as never));
  return { first, second, profiles, session };
}

test('one session admits Works with and without a metadata head using canonical profile owner keys', async () => {
  const f = fixture();
  await readWorkBasis(f.session, f.first);
  await readWorkBasis(f.session, f.second);
  f.profiles.unrelated = 'd'.repeat(64);
  await f.session.fenceDependencies();
});

test('canonical profile values still fence an actually consumed details profile', async () => {
  const f = fixture(); await readWorkBasis(f.session, f.first); await readWorkBasis(f.session, f.second);
  f.profiles['work-metadata-details-v1'] = 'e'.repeat(64);
  await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});
