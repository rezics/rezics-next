import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { tupleRoute } from '../../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { statementSlotId } from '../../../src/semantic/item.ts';
import type { Population } from '../../support/growth.ts';
import { citedValue, listRouteKey } from '../../semantic/support/list-presentation-fixture.ts';
import { expect } from 'bun:test';
import { cookies, password } from '../../access/native-account-bindings-fixture.ts';
import { createListPresentationFixture } from '../../semantic/support/list-presentation-fixture.ts';

/** Ordinary subject, identity, grant and Collection APIs supply every positive value. */
export async function createCollectionListFactsFixture(
  options: { db?: import('../../support/growth.ts').GrowthDatabase } = {},
) {
  const native = await createListPresentationFixture({
    poolMax: 1,
    ...(options.db === undefined ? {} : { db: options.db }),
  });
  try {
    await native.checked('POST', '/v1/platform/exposure/collections:open', {}, 'operator');
    const deps = await native.deps('editor');
    if (deps.actor.kind !== 'account') throw new Error('Native editor must authenticate');
    const clientId = deps.actor.clientId;
    async function credential(scopes: readonly string[]) {
      const signed = await native.auth.request('/signin', {
        account_id: native.accounts.editor,
        password,
        client_id: clientId,
        scope: scopes,
      });
      expect(signed.status).toBe(200);
      const token = await native.auth.request('/token', {}, cookies(signed));
      expect(token.status).toBe(200);
      return ((await token.json()) as { access_token: string }).access_token;
    }
    const bearer = await credential(deps.actor.scopes);
    async function get(id: string, view = 'FULL', selected: string | null = bearer, suffix = '') {
      return native.kernel.handle(
        new Request(`http://kernel.test/v1/collections/${id}/members?view=${view}${suffix}`, {
          headers: selected === null ? {} : { authorization: `Bearer ${selected}` },
        }),
      );
    }
    async function collection(ids: readonly string[], visibility = 'public', presentationKind?: string) {
      const { collection } = await native.checked('POST', '/v1/collections', {
        title: 'Native key fact page',
        visibility,
        ...(presentationKind ? { presentationKind } : {}),
      });
      for (const subjectId of ids)
        await native.checked('POST', `/v1/collections/${collection.id}/members`, { subjectId });
      return collection as { id: string; revision: number };
    }
    return { ...native, credential, get, collection };
  } catch (error) {
    await native.close();
    throw error;
  }
}
export type CollectionListFactsFixture = Awaited<ReturnType<typeof createCollectionListFactsFixture>>;

/** Unrelated noise only; measured positive values always come from the native APIs above. */
export function collectionListFactsPopulation(f: CollectionListFactsFixture, anchor: string): Population {
  return {
    name: 'list-facts-native-neighborhood',
    hotPartition: partitionOf(routeOf(anchor)!),
    hotShare: 1,
    rows({ route, ordinal }) {
      const subject = newId(route),
        candidate = newId(route),
        transaction = randomUUID();
      const property = 'schema:wordCount',
        slot = statementSlotId(subject, property);
      const source = 'list_growth',
        external_id = `unrelated-${ordinal}`;
      return {
        'semantic.subject': [
          {
            route,
            subject_id: subject,
            type: 'schema:Book',
            current_release: bundledDigest,
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.revision': [
          {
            route,
            subject_id: subject,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transaction,
          },
          {
            route,
            subject_id: subject,
            revision: 2,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: randomUUID(),
          },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: subject,
            candidate_id: candidate,
            slot_id: slot,
            property,
            rank: 'normal',
            statement: { ...citedValue(property, { amount: '+1', unit: '1' }), qualifiers: [], rank: 'normal' },
            release: bundledDigest,
            revision: 2,
            origin: 'proposal',
            view_order: 0,
          },
        ],
        'semantic.fact': [
          {
            route,
            subject_id: subject,
            slot_id: slot,
            log_seq: 1,
            kind: 'statement',
            property,
            operation: 'expand',
            body: {},
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.adoption': [
          {
            route,
            subject_id: subject,
            slot_id: slot,
            context_id: GLOBAL_CONTEXT,
            head: 1,
            mode: 'replace',
            selection: [],
            revision: 2,
          },
        ],
        'access.account': [
          { route, account_id: newId(route), kind: 'actor', state: 'active', transaction_id: transaction },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: subject,
            subject_id: f.accounts.reader,
            action: 'subject:read',
            valid: '(,)',
            transaction_id: transaction,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(route),
            transaction_id: transaction,
            epoch: 1,
            position: ordinal + 1,
            principal_kind: 'account',
            principal_id: f.accounts.editor,
            client_id: 'web',
          },
        ],
        'content.source_fences': [
          {
            route: tupleRoute(listRouteKey, source, external_id),
            source,
            external_id,
            field_group: 'facts',
            taken_down: false,
            security_revision: 1,
          },
        ],
      };
    },
  };
}
