import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { sourceTuple } from '../../src/semantic/fences.ts';
import { capture, checkGrowth, costOf, seed } from '../support/growth.ts';
import { realmBoardWorld } from '../content/realm-board-create-support.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;
beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);
afterAll(async () => {
  await world?.close();
});
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;

function nodes(value: unknown, relation: string): Record<string, any>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => nodes(entry, relation));
  const object = value as Record<string, any>;
  return [
    ...(object['Relation Name'] === relation ? [object] : []),
    ...Object.values(object).flatMap((entry) => nodes(entry, relation)),
  ];
}

// All authorization and selected truth are created through native HTTP commands.
// Bulk seed rows below are only distractors, never authority for the measured key.
test('real Realm caller stays bounded as unrelated catalogue and known Concept history and relation degree grow', async () => {
  for (const representation of ['compact', 'expanded', 'absent'] as const) {
    const id = await world.subject('skos:Concept', representation === 'compact' ? world.schemeId : undefined);
    let selected: string | undefined;
    let tuple: ReturnType<typeof sourceTuple> | undefined;
    if (representation === 'expanded') {
      const imported = await world.imported(id);
      selected = imported.candidate;
      tuple = sourceTuple(world.routeKey, imported.source);
      await world.adopt(id, selected);
    } else if (representation === 'absent') {
      selected = await world.propose(id, { type: 'value', content: await world.subject('skos:ConceptScheme') });
      await world.adopt(id, selected);
    }
    const key = crypto.randomUUID();
    const initial = await world.board(id, key);
    expect(initial.response.status).toBe(representation === 'absent' ? 403 : 201);
    const stable = ({ request_id: _requestId, ...value }: Record<string, unknown>) => value;
    const expected = stable(initial.value);
    const operation = async () => {
      const result = await world.board(id, key);
      expect(result.response.status).toBe(initial.response.status);
      expect(stable(result.value)).toEqual(expected);
      return { bytes: Buffer.byteLength(JSON.stringify(result.value)) };
    };
    for (const axis of ['catalogue', 'known-history-and-relations'] as const) {
      if (axis === 'known-history-and-relations' && !selected)
        await world.checked('POST', `/v1/subjects/${id}/candidates`, {
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.test/native-history' },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.test/history-source' },
                  },
                ],
              },
            ],
          },
        });
      const route = routeOf(id)!;
      const membershipSlot = statementSlotId(id, 'skos:inScheme');
      const baseRevision = Number(
        (
          await world.db.admin.query(
            'SELECT max(revision) AS revision FROM semantic.revision WHERE route=$1 AND subject_id=$2',
            [route, id],
          )
        ).rows[0].revision,
      );
      const report = await checkGrowth(world.db, {
        name: `Native Concept scheme ${representation} ${axis}`,
        scales: [64, 512, 4096],
        bounds,
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        counted: {
          read: (value) => value as { bytes: number },
          bounds: { bytes: 'constant', connections: 'constant' },
          limits: { connections: 1 },
        },
        grow: async (db, scale, previous) => {
          await seed(
            db,
            {
              name: `concept-scheme-${representation}-${axis}`,
              hotPartition: partitionOf(route),
              hotShare: 1,
              rows: ({ ordinal }) => {
                const other = newId(route),
                  candidate = newId(route),
                  transaction = crypto.randomUUID();
                const subject = axis === 'catalogue' ? other : id;
                const revision = axis === 'catalogue' ? 1 : baseRevision + ordinal + 1;
                const statement = {
                  property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
                  value: { type: 'value', content: newId(route) },
                  qualifiers: [],
                  references: [],
                  rank: 'normal',
                };
                const rows: Record<string, readonly Record<string, unknown>[]> = {
                  'semantic.subject': [],
                  'semantic.revision': [
                    {
                      route,
                      subject_id: subject,
                      revision,
                      kind: 'propose',
                      release: bundledDigest,
                      recorded_transaction_id: transaction,
                    },
                  ],
                  'semantic.candidate': [
                    {
                      route,
                      subject_id: subject,
                      candidate_id: candidate,
                      slot_id: axis === 'catalogue' ? statementSlotId(subject, 'skos:inScheme') : membershipSlot,
                      property: 'skos:inScheme',
                      rank: 'normal',
                      statement,
                      release: bundledDigest,
                      revision,
                      origin: 'proposal',
                      view_order: 0,
                    },
                  ],
                };
                if (axis === 'catalogue') {
                  rows['semantic.subject'] = [
                    {
                      route,
                      subject_id: subject,
                      type: 'skos:Concept',
                      current_release: bundledDigest,
                      recorded_transaction_id: transaction,
                    },
                  ];
                  // Grow the native slot and adoption indexes too. These other
                  // subjects have expanded, unselected slots; none supplies
                  // truth for the Concept measured by the caller.
                  rows['semantic.fact'] = [
                    {
                      route,
                      subject_id: subject,
                      slot_id: statementSlotId(subject, 'skos:inScheme'),
                      log_seq: 1,
                      operation: 'expand',
                      kind: 'statement',
                      property: 'skos:inScheme',
                      body: {},
                      recorded_transaction_id: transaction,
                    },
                  ];
                  rows['semantic.adoption'] = [
                    {
                      route,
                      subject_id: subject,
                      slot_id: statementSlotId(subject, 'skos:inScheme'),
                      context_id: GLOBAL_CONTEXT,
                      head: 1,
                      mode: 'replace',
                      selection: [],
                      revision,
                    },
                  ];
                  rows['access.resource_grant'] = [
                    {
                      route,
                      resource_id: subject,
                      subject_id: other,
                      action: 'subject:read',
                      valid: '(,)',
                      transaction_id: transaction,
                    },
                  ];
                  if (tuple)
                    rows['content.source_fences'] = [
                      {
                        route: tuple.route,
                        source: tuple.source,
                        external_id: other,
                        field_group: 'facts',
                        taken_down: false,
                        security_revision: 1,
                      },
                    ];
                } else {
                  // Expanded membership candidate history is unselected. For a compact
                  // membership slot, grow an unrelated property's proposal history instead:
                  // a native editorial write to membership would expand that slot.
                  if (!selected)
                    rows['semantic.candidate'] = [
                      {
                        ...rows['semantic.candidate']![0],
                        slot_id: statementSlotId(id, 'schema:url'),
                        property: 'schema:url',
                        statement: {
                          property: { id: 'schema:url', data_type: 'url' },
                          value: { type: 'value', content: 'https://example.test/' + other },
                          qualifiers: [],
                          references: [],
                          rank: 'normal',
                        },
                      },
                    ];
                  rows['semantic.inbound_link'] = [
                    {
                      route,
                      subject_id: id,
                      property: 'skos:broader',
                      source_subject_id: other,
                      statement_id: candidate,
                      source_revision: 1,
                      present: true,
                      recorded_transaction_id: transaction,
                    },
                  ];
                  rows['semantic.outbound_link'] = [
                    {
                      route,
                      subject_id: id,
                      property: 'schema:sameAs',
                      filter_value: other,
                      order_key: other,
                      target_subject_id: other,
                      statement_id: candidate,
                      slot_id: statementSlotId(id, 'schema:sameAs'),
                      relation: false,
                      source_revision: revision,
                      value: 'value',
                      present: false,
                      recorded_transaction_id: transaction,
                    },
                  ];
                }
                return rows;
              },
            },
            { from: previous, to: scale },
          );
        },
        operation,
      });
      const measured = await capture(world.db, operation, { includeBackends: true });
      const cost = costOf(measured.capture);
      expect(measured.capture.statements.join('\n')).not.toMatch(
        /consumer_checkpoint|projection_pending|semantic\.(?:outbound_link|inbound_link)\b/,
      );
      const plans = JSON.stringify(measured.capture.plans);
      expect(plans).toContain('fact_pkey');
      expect(plans).toContain('revision_identity_version');
      if (representation !== 'compact') {
        expect(plans).toContain('adoption_pkey');
        expect(plans).toContain('candidate_pkey');
      }
      if (tuple) expect(plans).toContain('source_fences_pkey');
      // The harness counts examined and removed rows and applies the shared
      // measured-layout rule. Inspect useful key conditions too, including
      // the complete empty/mismatched slot path; no planner settings change.
      for (const relation of [
        'subject',
        'fact',
        'candidate',
        'adoption',
        'revision',
        ...(tuple ? ['source_fences'] : []),
      ]) {
        const scans = nodes(measured.capture.plans, relation).filter((node) => /Index/.test(node['Node Type']));
        if (scans.length) expect(scans.some((node) => String(node['Index Cond']).includes('route'))).toBe(true);
      }
      console.log(
        JSON.stringify({
          representation,
          axis,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
          controls: cost.controlStatements,
          requestBytes: cost.requestBytes,
          responseBytes: cost.responseBytes,
          bytes: measured.value.bytes,
          connections: new Set(measured.capture.statementBackends).size,
          relations: cost.relations,
        }),
      );
      expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
      console.log(
        JSON.stringify({
          representation,
          axis,
          samples: report.samples.map(({ scale, cost, counted }) => ({ scale, cost, counted })),
        }),
      );
    }
  }
}, 240_000);
