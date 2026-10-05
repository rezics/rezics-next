import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionInsufficientScope } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import type { ExportPlan } from '../../../services/main/src/modules/export/planner.ts';
import type { ExportSelection } from '../../../services/main/src/modules/export/readers.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { scopedJudgmentsFixture, type Opinion } from './scoped-judgments-support.ts';

export type Manifest = { manifestId: string; plan: ExportPlan };
export type Page = { rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
export async function scopedExportFixture() {
  const f = await scopedJudgmentsFixture();
  const people = [f.owner, f.outsider];
  const scopes = new Set([
    'export:create',
    'export:read',
    'rating:read',
    'work:read',
    'context:read',
  ]);
  const verifiedScopes: string[][] = [];
  const app = createMainApp(f.stack.fuseki, {
    environment: f.stack.env,
    access: f.stack.access,
    content: f.stack.content,
    media: f.stack.media,
    mediaAccess: f.stack.mediaAccess,
    account: {
      verify: async (request, required) => {
        verifiedScopes.push([...required]);
        if (required.some((scope) => !scopes.has(scope)))
          throw new AccountAssertionInsufficientScope();
        const person = people.find(
          (person) => request.headers.get('authorization') === `Bearer ${person.token}`,
        );
        if (!person) throw new AccountAssertionInsufficientScope();
        const principal = { ...person.principal, emailVerified: true };
        return { ...principal, currentAssertion: async () => principal };
      },
    },
    exports: new ExportStore(f.stack.contentPool),
    libraryBundle: new LibraryBundleExporter(f.stack.contentPool, f.stack.accessPool),
    targetRatingInventory: new TargetRatingInventoryStore(f.stack.accessPool),
  });
  const call = (method: string, path: string, body?: object, key = crypto.randomUUID()) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          authorization: `Bearer ${f.owner.token}`,
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const subject = await f.semantic('Exported subject');
  const projection = await f.project(subject, [f.work.work]);
  const context = await f.question();
  await f.grant(f.owner, `rating:observe:${context.context}`, 'rating.observation.set');
  await f.grant(f.owner, `export:${context.context}`, 'export.create');
  const own = await f.json<Opinion>(
    await f.call(
      f.owner,
      'POST',
      '/v1/rating-observations',
      f.ratingBody(f.owner, context.context, projection.id),
    ),
    201,
  );
  const aggregate = await f.json<{
    sourcePosition: { dataEpoch: string; sequence: string };
    lastAdmissionId: string;
  }>(
    await f.call(f.owner, 'POST', '/v1/rating-aggregates', {
      profile: 'realm-target-latest-mean-v1',
      context: context.context,
      target: projection.id,
      actingSubject: f.owner.actor,
    }),
  );
  aggregate.sourcePosition = {
    dataEpoch: aggregate.sourcePosition.dataEpoch,
    sequence: aggregate.sourcePosition.sequence,
  };
  const selection: ExportSelection = {
    kind: 'rating-aggregate',
    reference: context.context,
    target: projection.id,
    expectedPosition: aggregate.sourcePosition,
  };
  const exportSelection = (selection: ExportSelection, key?: string) =>
    call(
      'POST',
      '/v1/exports',
      {
        profile: 'export-create-v1',
        actingSubject: f.owner.actor,
        useScope: 'evaluation',
        selection,
      },
      key,
    );
  const libraryPage = (cursor?: string | null, snapshot?: string, limit = 20) =>
    call(
      'GET',
      `/v1/me/library-export?${new URLSearchParams({
        actingSubject: f.owner.actor,
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
        ...(snapshot ? { snapshot } : {}),
      })}`,
    );
  return {
    ...f,
    callExport: call,
    subject,
    projection,
    context,
    own,
    aggregate,
    selection,
    exportSelection,
    libraryPage,
    scopes,
    verifiedScopes,
  };
}
