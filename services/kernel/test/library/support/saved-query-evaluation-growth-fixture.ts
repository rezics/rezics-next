import { expect } from 'bun:test';
import { routeOf } from '../../../src/route/route.ts';
import { createCollectionRulesFixture } from './collection-rules-fixture.ts';

type ExplainNode = {
  'Node Type'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
};

export async function createSavedQueryEvaluationGrowthFixture() {
  const base = await createCollectionRulesFixture();
  try {
    const subjectIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await base.subject(`Saved member ${i}`);
      await base.entry(id);
      subjectIds.push(id);
    }
    const targetSubjectId = [...subjectIds].sort()[0]!;
    const unrelatedSubjectId = await base.subject('Unrelated retained-label subject');
    const otherSubjectResponse = await base.send(
      'POST',
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: 'Other account retained-label subject' } },
      base.other,
    );
    expect(otherSubjectResponse.status).toBe(201);
    const otherSubject = (await otherSubjectResponse.json()) as { subject: { id: string } };
    const otherSubjectId = otherSubject.subject.id;
    const otherEntry = await base.send(
      'PUT',
      `/v1/libraryEntries/${otherSubjectId}`,
      { state: base.state },
      base.other,
    );
    expect(otherEntry.status).toBe(201);
    const otherRoute = routeOf(otherSubjectId);
    if (otherRoute === null) throw new Error('Other account subject has no route');
    const otherOwner = await base.database.admin.query<{ accountId: string }>(
      `SELECT account_id::text AS "accountId" FROM library.entry WHERE route=$1 AND subject_id=$2`,
      [otherRoute, otherSubjectId],
    );
    const otherAccountId = otherOwner.rows[0]?.accountId;
    if (!otherAccountId) throw new Error('Other account entry did not retain its owner identity');
    const criterionResponse = await base.send('POST', '/v1/libraryLabels', { name: 'Saved member criterion' });
    expect(criterionResponse.status).toBe(201);
    const criterion = (await criterionResponse.json()) as { label: { id: string } };
    const filter = {
      and: [{ owner: { presence: true } }, { not: { owner: { label: { id: criterion.label.id } } } }],
    };
    const created = await base.send('POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title: 'Private saved member evaluation',
      visibility: 'private',
      rule: { filter },
    });
    expect(created.status).toBe(201);
    const saved = (await created.json()) as { collection: { id: string } };
    const collectionId = saved.collection.id;
    const ownerAccountId = base.runtime.identity.ordinary.accountId;
    const route = routeOf(ownerAccountId);
    if (route === null) throw new Error('Saved query owner has no route');

    function pagePath(cursor: string | undefined, limit: number) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== undefined) query.set('cursor', cursor);
      return `/v1/collections/${collectionId}/members?${query}`;
    }

    async function requestPage(cursor?: string, limit = 2, bearer = base.owner) {
      return base.send('GET', pagePath(cursor, limit), undefined, bearer);
    }

    async function settlePage(cursor?: string, limit = 2, bearer = base.owner) {
      const path = pagePath(cursor, limit);
      let preparations = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await base.send('GET', path, undefined, bearer);
        if (response.status !== 202) return { response, preparations };
        preparations++;
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('retry-after')).not.toBeNull();
        expect(await response.json()).toEqual({ preparing: true });
        await Bun.sleep(10);
      }
      throw new Error('Finite saved Collection never reached a useful members page');
    }

    async function retainedCount(accountId: string, subjectId: string) {
      const accountRoute = routeOf(accountId);
      if (accountRoute === null) throw new Error('Retained-label owner has no route');
      const result = await base.database.admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM library.label_assignment
         WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND deleted_at IS NOT NULL`,
        [accountRoute, accountId, subjectId],
      );
      return result.rows[0]?.count ?? 0;
    }

    async function retainDeletedHistory(
      subjectId: string,
      total: number,
      bearer = base.owner,
      accountId = ownerAccountId,
    ) {
      const existing = await retainedCount(accountId, subjectId);
      for (let index = existing; index < total; index++) {
        const labelResponse = await base.send(
          'POST',
          '/v1/libraryLabels',
          { name: `saved-history-${subjectId.slice(0, 8)}-${index}` },
          bearer,
        );
        expect(labelResponse.status).toBe(201);
        const label = (await labelResponse.json()) as { label: { id: string } };
        const assignedResponse = await base.send(
          'POST',
          `/v1/libraryLabels/${label.label.id}:assign`,
          { subjectId },
          bearer,
        );
        expect(assignedResponse.status).toBe(200);
        const assigned = (await assignedResponse.json()) as { assignment: { id: string; revision: number } };
        const removed = await base.send(
          'POST',
          `/v1/libraryLabels/${label.label.id}:unassign`,
          { subjectId, assignmentId: assigned.assignment.id, revision: assigned.assignment.revision },
          bearer,
        );
        expect(removed.status).toBe(200);
      }
      expect(await retainedCount(accountId, subjectId)).toBeGreaterThanOrEqual(total);
    }

    async function completeSession(subjectId: string) {
      const scalar = base.profile.progress?.allowed.find((choice) => choice.mode === 'scalar_amount');
      const unit = scalar?.units.find((choice) => choice.totalPolicy !== 'required');
      if (!scalar || !unit) throw new Error('Released scalar progress unit is required for source growth');
      const started = await base.send('POST', '/v1/progressSessions', {
        subjectId,
        mode: 'scalar_amount',
        unit: unit.id,
      });
      expect(started.status).toBe(201);
      const session = (await started.json()) as { progressSession: { id: string; revision: number } };
      const completed = await base.send('POST', `/v1/progressSessions/${session.progressSession.id}:complete`, {
        revision: session.progressSession.revision,
      });
      expect(completed.status).toBe(200);
    }

    async function unidentifiedWitness() {
      const assigned = await base.send('POST', `/v1/libraryLabels/${criterion.label.id}:assign`, {
        subjectId: targetSubjectId,
      });
      expect(assigned.status).toBe(200);
      const receipt = (await assigned.json()) as { assignment: { id: string } };
      const identity = { route, accountId: ownerAccountId, subjectId: targetSubjectId, labelId: criterion.label.id };
      const selected = await base.database.admin.query<{ slot: number | null }>(
        `SELECT slot_no AS slot FROM library.label_assignment
         WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4 AND assignment_id=$5 AND deleted_at IS NULL`,
        [...Object.values(identity), receipt.assignment.id],
      );
      const slot = selected.rows[0]?.slot;
      if (slot === null || slot === undefined) throw new Error('Live assignment did not retain its native slot');
      await base.database.admin.query(
        `UPDATE library.label_assignment SET slot_no=NULL
         WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4 AND assignment_id=$5 AND deleted_at IS NULL`,
        [...Object.values(identity), receipt.assignment.id],
      );
      return async () => {
        await base.database.admin.query(
          `UPDATE library.label_assignment SET slot_no=$6
           WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4 AND assignment_id=$5 AND deleted_at IS NULL`,
          [...Object.values(identity), receipt.assignment.id, slot],
        );
      };
    }

    async function explainUnidentifiedWitness() {
      const result = await base.database.admin.query<{ 'QUERY PLAN': { Plan: ExplainNode }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT a.label_id FROM library.label_assignment a
         WHERE a.route=$1 AND a.account_id=$2 AND a.subject_id=$3
           AND a.deleted_at IS NULL AND (a.slot_no IS NULL OR a.assignment_id IS NULL)
         ORDER BY a.label_id LIMIT 1`,
        [route, ownerAccountId, targetSubjectId],
      );
      const plan = result.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
      if (!plan) throw new Error('Native EXPLAIN did not return a plan');
      return plan;
    }

    return {
      ...base,
      subjectIds,
      targetSubjectId,
      unrelatedSubjectId,
      otherSubjectId,
      collectionId,
      criterionLabelId: criterion.label.id,
      ownerAccountId,
      otherAccountId,
      requestPage,
      settlePage,
      retainedCount,
      retainDeletedHistory,
      completeSession,
      unidentifiedWitness,
      explainUnidentifiedWitness,
    };
  } catch (error) {
    await base.close();
    throw error;
  }
}

export type SavedQueryEvaluationGrowthFixture = Awaited<ReturnType<typeof createSavedQueryEvaluationGrowthFixture>>;
