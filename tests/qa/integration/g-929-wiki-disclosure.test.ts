import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checked, publishedWiki } from './g-929-wiki-support.ts';
import type { WikiHistory } from '../../../services/main/src/modules/wiki/history.ts';
import { DisclosureUnavailable } from '../../../services/main/src/modules/disclosure/read.ts';
import { readWikiExport } from '../../../services/main/src/modules/export/wiki.ts';
import {
  ExportSourceNotFound,
  ExportStale,
} from '../../../services/main/src/modules/export/readers.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { propertyRevelationRecord } from '../../../services/main/src/modules/reading-position/store.ts';

type History = WikiHistory & {
  sourcePosition: { dataEpoch: string; sequence: string };
  nextCursor: string | null;
};
type Wiki = Awaited<ReturnType<typeof publishedWiki>>;
const path = (wiki: Wiki, suffix = '', resource = wiki.work.work) =>
  `/v1/wiki/${resource.slice(-36)}/history?position=all&actingSubject=${encodeURIComponent(wiki.reader.actor)}${suffix}`;
const history = async (wiki: Wiki, suffix = '') =>
  checked<History>(await wiki.call('GET', path(wiki, suffix), undefined, wiki.reader.token));
const pin = (value: History) => `&revisions=${encodeURIComponent(JSON.stringify(value.revisions))}`;
async function exportWiki(
  wiki: Wiki,
  value: History,
  scope?: { entity?: string; section?: 'characters' },
) {
  await wiki.reader.grant(`export:${wiki.work.work}`, 'export.create');
  return wiki.call(
    'POST',
    '/v1/exports',
    {
      profile: 'export-create-v1',
      actingSubject: wiki.reader.actor,
      useScope: 'quotation',
      selection: {
        kind: 'wiki-revision-set',
        reference: wiki.work.work,
        revisions: value.revisions,
        expectedPosition: value.sourcePosition,
        ...(scope ? { scope } : {}),
      },
    },
    wiki.reader.token,
  );
}
async function rate(
  wiki: Wiki,
  target: string,
  labels: string[],
  expectedRevision: string | null = null,
) {
  await wiki.holder.grant('governance:platform', 'governance.moderate');
  return checked<{ assessment: { revision: string } }>(
    await wiki.call('PUT', `/v1/suitability/${target.slice(-36)}`, {
      actingSubject: wiki.holder.actor,
      expectedRevision,
      labels,
      basis: 'platform',
    }),
  );
}
function scopes(wiki: Wiki, value: History) {
  return [
    '',
    `&entity=${encodeURIComponent(wiki.entity)}`,
    '&section=characters',
    '&section=chapters',
  ].flatMap((scope) => [scope, scope + pin(value)]);
}
async function absent(response: Response, status = 404) {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  for (const sensitive of [
    'Royal identity',
    'Secret royal heir',
    'The masked traveller arrived.',
    'Hidden witness',
  ])
    expect(body).not.toContain(sensitive);
  return body;
}

/** A committed governance read fixture, including its case/decision references.
 * This exercises real enforcement evaluation; moderation admission has its own suite. */
async function removal(
  wiki: Wiki,
  resource: string,
  component: 'record' | 'name' | 'title',
  revision: string,
  effect: 'disclosure' | 'export' = 'disclosure',
) {
  await wiki.holder.grant('governance:platform', 'governance.moderate');
  const caseId = randomUUID(),
    decisionId = randomUUID(),
    fenceId = randomUUID();
  const principalId = await wiki.f.access.activePrincipalId(wiki.holder.principal);
  const client = await wiki.f.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,$3,'private')`,
      [caseId, resource, component],
    );
    await client.query(
      `INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
      authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform','governance:platform',
      0,$5,$1::text,$5,'urn:rezics:rule:g929','1',$5,$5,'private')`,
      [decisionId, caseId, principalId, wiki.holder.actor, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
      VALUES ($1,1,'graph',$2,$3,'exact_revision',$4,$4,$5)`,
      [decisionId, resource, component, revision, effect],
    );
    await client.query(
      `INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,$3,$4,$5,$6,1,'restricted',1)`,
      [fenceId, resource, component, revision, effect, decisionId],
    );
    await client.query(
      'UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1',
      [caseId, decisionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return async () => {
    const restored = randomUUID(),
      restore = await wiki.f.accessPool.connect();
    try {
      await restore.query('BEGIN');
      await restore.query(
        `INSERT INTO access.moderation_decision
        (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure)
        SELECT $1::uuid,kind,'restore',context,case_id,case_sequence+1,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,$1::text,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure
        FROM access.moderation_decision WHERE id=$2`,
        [restored, decisionId],
      );
      await restore.query(
        `INSERT INTO access.moderation_decision_target
        (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
        SELECT $1,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect
        FROM access.moderation_decision_target WHERE decision_id=$2`,
        [restored, decisionId],
      );
      await restore.query(
        "UPDATE access.governance_case SET decision_head=$2,generation=2,state='closed',closed_at=clock_timestamp() WHERE id=$1",
        [caseId, restored],
      );
      await restore.query(
        "UPDATE access.governance_enforcement SET state='released',decision_id=$2,fence_epoch=fence_epoch+1 WHERE id=$1",
        [fenceId, restored],
      );
      await restore.query('COMMIT');
    } catch (error) {
      await restore.query('ROLLBACK');
      throw error;
    } finally {
      restore.release();
    }
  };
}

test('G929: current exact record, name and pin removals precede history and export hydration', async () => {
  const wiki = await publishedWiki();
  try {
    const permitted = await history(wiki),
      claim = permitted.claims[0]!,
      entity = permitted.entities[0]!;
    for (const [resource, component, revision] of [
      [claim.claim, 'record', claim.revision],
      [claim.revision, 'record', claim.revision],
    ] as const) {
      const release = await removal(wiki, resource, component, revision);
      expect((await history(wiki, pin(permitted))).claims).toEqual([]);
      expect(JSON.stringify(await checked(await exportWiki(wiki, permitted), 201))).not.toContain(
        'Royal identity',
      );
      await release();
    }
    const alias = entity.names.find((name) => name.kind === 'alias')!;
    const record = propertyRevelationRecord(entity.entity, 'https://schema.org/alternateName', {
      kind: 'language-string',
      lexical: alias.value,
      language: alias.language,
    });
    const releaseAlias = await removal(wiki, record, 'record', entity.revision);
    expect(JSON.stringify(await history(wiki, pin(permitted)))).not.toContain('Secret royal heir');
    expect(JSON.stringify(await checked(await exportWiki(wiki, permitted), 201))).not.toContain(
      'Secret royal heir',
    );
    await releaseAlias();
    const releaseName = await removal(wiki, entity.entity, 'name', entity.revision);
    const shown = await history(wiki, pin(permitted));
    expect(shown.entities).toEqual([]);
    expect(shown.claims).toEqual([]);
    await releaseName();
    const head = (
      await wiki.f.fuseki.query(
        `SELECT ?head WHERE { GRAPH <${GRAPHS.current}> { <${wiki.work.work}> <${RV}head> ?head } }`,
      )
    ).results!.bindings[0]!.head!.value;
    const releaseExport = await removal(wiki, wiki.work.work, 'title', head, 'export');
    expect((await history(wiki)).claims).toHaveLength(1);
    await absent(await exportWiki(wiki, permitted));
    await releaseExport();
    await removal(wiki, wiki.work.work, 'title', head);
    for (const scope of scopes(wiki, permitted))
      await absent(await wiki.call('GET', path(wiki, scope), undefined, wiki.reader.token));
    await absent(await exportWiki(wiki, permitted));
  } finally {
    await wiki.f.stop();
  }
}, 180_000);

test('G929: scoped and pinned history/export preserve controls and withhold a rated Work on every page', async () => {
  const wiki = await publishedWiki();
  try {
    const permitted = await history(wiki);
    expect(permitted.claims).toHaveLength(1);
    expect(JSON.stringify(permitted)).toContain('Secret royal heir');
    for (const scope of scopes(wiki, permitted))
      expect((await history(wiki, scope)).work).toBe(wiki.work.work);
    const first = await history(wiki, `${pin(permitted)}&limit=1`);
    expect(first.nextCursor).not.toBeNull();
    const exported = await checked<{ manifestId: string; plan: unknown }>(
      await exportWiki(wiki, permitted),
      201,
    );
    expect(JSON.stringify(exported.plan)).toContain('Royal identity');
    for (const scope of [{ entity: wiki.entity }, { section: 'characters' as const }])
      expect(
        JSON.stringify(await checked(await exportWiki(wiki, permitted, scope), 201)),
      ).toContain('Royal identity');
    expect(
      (
        await checked<History>(
          await wiki.call(
            'GET',
            path(wiki).replace('position=all', 'position=start'),
            undefined,
            wiki.reader.token,
          ),
        )
      ).claims,
    ).toEqual([]);
    const assessment = await rate(wiki, wiki.work.work, ['r18']);
    const missing = await absent(
      await wiki.call(
        'GET',
        path(wiki, '', `https://rezics.com/id/${randomUUID()}`),
        undefined,
        wiki.reader.token,
      ),
    );
    for (const scope of scopes(wiki, permitted))
      expect(
        await absent(await wiki.call('GET', path(wiki, scope), undefined, wiki.reader.token)),
      ).toBe(missing);
    await absent(
      await wiki.call(
        'GET',
        path(wiki, `${pin(permitted)}&limit=1&cursor=${first.nextCursor}`),
        undefined,
        wiki.reader.token,
      ),
    );
    for (const scope of [undefined, { entity: wiki.entity }, { section: 'characters' as const }])
      await absent(await exportWiki(wiki, permitted, scope));
    await absent(
      await wiki.call('GET', `/v1/exports/${exported.manifestId}`, undefined, wiki.reader.token),
    );
    await rate(wiki, wiki.work.work, [], assessment.assessment.revision);
    expect((await history(wiki, pin(permitted))).claims).toEqual(permitted.claims);
    expect((await exportWiki(wiki, permitted)).status).toBe(201);
    await wiki.f.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [
      `work:read:${wiki.work.work}`,
    ]);
    await absent(
      await wiki.call(
        'GET',
        path(wiki, `${pin(permitted)}&limit=1&cursor=${first.nextCursor}`),
        undefined,
        wiki.reader.token,
      ),
    );
    await absent(await exportWiki(wiki, permitted));
  } finally {
    await wiki.f.stop();
  }
}, 180_000);

test('G929: restricted references disappear before pagination, including pinned and scoped exports', async () => {
  const wiki = await publishedWiki({ reference: true });
  try {
    const permitted = await history(wiki);
    expect(permitted.claims).toHaveLength(2);
    const reference = wiki.reference!.component;
    // A strong Access closure defeats both the public baseline and any grants.
    await wiki.holder.grant(`semantic:read:${reference}`, 'semantic.read');
    await wiki.f.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [
      `semantic:read:${reference}`,
    ]);
    for (const scope of ['', `&entity=${encodeURIComponent(wiki.entity)}`, '&section=characters']) {
      const shown = await history(wiki, scope + pin(permitted));
      expect(shown.claims).toHaveLength(1);
      expect(shown.entities.map((row) => row.entity)).not.toContain(reference);
      expect(JSON.stringify(shown)).not.toContain('Hidden witness');
      const plan = await checked(
        await exportWiki(
          wiki,
          permitted,
          scope.includes('entity=') ? { entity: wiki.entity } : undefined,
        ),
        201,
      );
      expect(JSON.stringify(plan)).not.toContain(reference);
      expect(JSON.stringify(plan)).toContain('Royal identity');
    }
    const expected = await history(wiki, pin(permitted));
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await history(
        wiki,
        `${pin(permitted)}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.claims.length + page.entities.length + page.units.length).toBe(1);
      paged.push(
        ...page.claims.map((row) => row.claim),
        ...page.entities.map((row) => row.entity),
        ...page.units.map((row) => row.id),
      );
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged.sort()).toEqual(
      [
        ...expected.claims.map((row) => row.claim),
        ...expected.entities.map((row) => row.entity),
        ...expected.units.map((row) => row.id),
      ].sort(),
    );
    await wiki.f.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1', [
      `semantic:read:${reference}`,
    ]);
    await rate(wiki, reference, ['r18g']);
    expect((await history(wiki, pin(permitted))).claims).toHaveLength(1);
    expect(JSON.stringify(await checked(await exportWiki(wiki, permitted), 201))).not.toContain(
      'Hidden witness',
    );
  } finally {
    await wiki.f.stop();
  }
}, 180_000);

test('G929: exact erased pins and current removal cannot be recovered through historical selections', async () => {
  const wiki = await publishedWiki();
  try {
    const permitted = await history(wiki),
      claim = permitted.claims[0]!;
    await wiki.f.fuseki.update(
      `INSERT DATA { GRAPH <${GRAPHS.revisions}> { <${claim.revision}> a <${RV}ErasedRevision> } }`,
    );
    const shown = await history(wiki, pin(permitted));
    expect(shown.claims).toEqual([]);
    expect(shown.sourcePosition).toEqual(permitted.sourcePosition);
    const exportBody = await checked(await exportWiki(wiki, permitted), 201);
    expect(JSON.stringify(exportBody)).not.toContain('Royal identity');
    expect(JSON.stringify(exportBody)).not.toContain('The masked traveller arrived.');
    await wiki.f.fuseki.update(
      `INSERT DATA { GRAPH <${GRAPHS.current}> { <${wiki.work.work}> <${RV}protectionHead> <https://rezics.com/id/${randomUUID()}> } }`,
    );
    for (const scope of scopes(wiki, permitted))
      await absent(await wiki.call('GET', path(wiki, scope), undefined, wiki.reader.token));
    await absent(await exportWiki(wiki, permitted));
  } finally {
    await wiki.f.stop();
  }
}, 180_000);

test('G929: assessment outage and revocation during hydration/export planning fail closed', async () => {
  const wiki = await publishedWiki();
  const disclosure = wiki.governance.disclosure.read.bind(wiki.governance.disclosure);
  try {
    const permitted = await history(wiki);
    wiki.governance.disclosure.read = async () => {
      throw new DisclosureUnavailable('Assessment owner unavailable');
    };
    for (const scope of scopes(wiki, permitted))
      await absent(await wiki.call('GET', path(wiki, scope), undefined, wiki.reader.token), 503);
    await absent(await exportWiki(wiki, permitted), 503);
    wiki.governance.disclosure.read = disclosure;
    // The quote owner pauses after the initial admission without moving Fuseki.
    const withheld = wiki.deps.wikiEvidence!.withheld.bind(wiki.deps.wikiEvidence);
    wiki.deps.wikiEvidence!.withheld = async (...args) => {
      await rate(wiki, wiki.work.work, ['r18']);
      wiki.deps.wikiEvidence!.withheld = withheld;
      return withheld(...args);
    };
    await absent(await wiki.call('GET', path(wiki), undefined, wiki.reader.token));
  } finally {
    wiki.governance.disclosure.read = disclosure;
    await wiki.f.stop();
  }
}, 180_000);

test('G929: export uses its own disclosure channel and fences an asynchronous rights decision', async () => {
  const wiki = await publishedWiki();
  const disclosure = wiki.governance.disclosure.read.bind(wiki.governance.disclosure);
  try {
    const permitted = await history(wiki);
    const channels: string[] = [];
    wiki.governance.disclosure.read = async (targets, viewer, channel) => {
      channels.push(channel);
      const result = await disclosure(targets, viewer, channel);
      return result.map((decision, index) =>
        channel === 'export' && targets[index]!.resource === wiki.work.work ? 'hidden' : decision,
      );
    };
    expect((await history(wiki)).claims).toHaveLength(1);
    await absent(await exportWiki(wiki, permitted));
    expect(channels).toContain('export');
    wiki.governance.disclosure.read = disclosure;
    let ratedRevision: string | null = null;
    await expect(
      readWikiExport(
        wiki.deps,
        wiki.reader.principal,
        wiki.reader.actor,
        wiki.work.work,
        permitted.revisions,
        permitted.sourcePosition,
        'quotation',
        async () => {
          ratedRevision = (await rate(wiki, wiki.work.work, ['r18'])).assessment.revision;
          return [];
        },
      ),
    ).rejects.toBeInstanceOf(ExportSourceNotFound);
    // A changed derivative during rights planning also invalidates a manifest.
    await rate(wiki, wiki.work.work, [], ratedRevision);
    await expect(
      readWikiExport(
        wiki.deps,
        wiki.reader.principal,
        wiki.reader.actor,
        wiki.work.work,
        permitted.revisions,
        permitted.sourcePosition,
        'quotation',
        async () => {
          await rate(wiki, wiki.entity, ['r18']);
          return [];
        },
      ),
    ).rejects.toBeInstanceOf(ExportStale);
  } finally {
    wiki.governance.disclosure.read = disclosure;
    await wiki.f.stop();
  }
}, 180_000);
