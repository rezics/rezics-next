import type { Pool } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { publicTargetRead, resolveTargets, targetRead } from '../target/resolve.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import {
  relationshipEligible,
  relationshipRecipients,
  type RelationshipRecipients,
} from '../follows/recipients.ts';
import { externalAuthorFollow } from '../follows/contract.ts';
import type { NotificationEvent } from '../notification/store.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { notificationWorkTitle } from '../notification/display.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { parseStoredRelease, RELEASE_V2_COST } from '../release/schema.ts';

async function releaseLanguages(
  graph: Pick<FusekiClient, 'query'>,
  target: string,
  work: string,
): Promise<string[]> {
  const rows =
    (
      await graph.query(
        `PREFIX rv: <${RV}> SELECT ?state WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(target)} rv:releaseHead ?head } GRAPH ${iri(GRAPHS.revisions)} { ?head rv:releaseState ?state }
  } LIMIT 2`,
        RELEASE_V2_COST.stateBytes * 2,
      )
    ).results?.bindings ?? [];
  if (rows.length > 1) throw new Error('Release notification state is ambiguous');
  return rows[0]?.state ? parseStoredRelease(rows[0].state.value, work).contentLanguages : [];
}

async function collectionProof(graph: Pick<FusekiClient, 'query'>, target: string) {
  const { readResourceSummaries } = await import('../media/summary.ts');
  return publicTargetRead(graph, async (session) => {
    const summary = (
      await readResourceSummaries(
        session.deps.environment,
        undefined,
        {},
        {
          resources: [target],
          context: DEFAULT_MEDIA_CONTEXT,
          language: null,
          includeCollections: true,
        },
      )
    ).summaries[0];
    return summary?.status === 'available' &&
      summary.type === 'collection' &&
      summary.disclosure === 'public'
      ? summary
      : null;
  });
}

/** Three public primary credits, native or keyed, are a bounded recipient
 * interest lookup. Descriptive text never supplies a native recipient. */
async function interestTargets(graph: Pick<FusekiClient, 'query'>, target: string, work: string) {
  const rows =
    (
      await graph.query(
        `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?agent ?key WHERE { { GRAPH ${iri(GRAPHS.current)} { ?credit rv:work ${iri(work)} ; schema:roleName "author" .
      { ?credit a rv:NativeAgentCredit ; rv:agent ?agent }
      UNION { ?credit a rv:AuthorCredit ; rv:externalProvider "open-library" ; rv:externalKey ?key ; rv:editControl rv:HumanConfirmed }
    } } UNION { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:mainVersion ?main . ?main rv:selectionHead ?selection .
      ?contribution a rv:TextContribution ; rv:work ${iri(work)} ; rv:author ?agent ; rv:publicationHead ?decision }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:contribution ?contribution ; rv:publicationDecision ?decision }
    } } ORDER BY ?credit LIMIT 3`,
        16_384,
      )
    ).results?.bindings ?? [];
  return [
    ...new Set([
      target,
      work,
      ...rows.flatMap((row) =>
        row.agent
          ? [row.agent.value]
          : row.key?.value.match(/^\/authors\/OL[1-9][0-9]{0,11}A$/)
            ? [externalAuthorFollow(row.key.value)]
            : [],
      ),
    ]),
  ];
}
/** Uses only the existing WorkCreated and ReleaseChanged relay event kinds.
 * The current public target gate runs before recipient discovery. */
export async function resourceNotification(
  access: Pool,
  graph: Pick<FusekiClient, 'query'>,
  envelope: { id: string; type: string; data: { receipt?: Record<string, unknown> } },
): Promise<NotificationEvent | null> {
  const selected = envelope.type === 'com.rezics.publication.selection-changed.v1';
  const created = selected || envelope.type === 'com.rezics.work.created.v1';
  const collection = envelope.type === 'com.rezics.collection.name-published.v1';
  if (
    !created &&
    !collection &&
    !['com.rezics.release.changed.v1', 'com.rezics.release.sealed.v1'].includes(envelope.type)
  )
    return null;
  const receipt = envelope.data.receipt;
  const target = created
    ? receipt?.work
    : collection
      ? receipt?.collection
      : (receipt?.release ?? receipt?.fixedRelease);
  if (typeof target !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target))
    return null;
  try {
    if (selected) {
      const selection = receipt?.selection;
      if (typeof selection !== 'string') return null;
      const first = (
        await graph.query(
          `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selection)} a rv:PublicationSelection . FILTER NOT EXISTS { ${iri(selection)} rv:predecessor ?previous }
      } }`,
          4096,
        )
      ).boolean;
      if (!first) return null;
    }
    const resolved = collection
      ? await collectionProof(graph, target)
      : (
          await publicTargetRead(graph, (session) =>
            resolveTargets(session, [target], 'discussion'),
          )
        )[0];
    if (!resolved) return null;
    const work = collection ? target : (resolved.work ?? (created ? target : null));
    if (!work) return null;
    const actor =
      typeof receipt?.admissionId === 'string'
        ? (
            await access.query<{ principal_id: string }>(
              'SELECT principal_id FROM access.admission WHERE id=$1',
              [receipt.admissionId],
            )
          ).rows[0]?.principal_id
        : null;
    const targets = collection ? [target] : await interestTargets(graph, target, work);
    const languages = created || collection ? [] : await releaseLanguages(graph, target, work);
    const relationshipPlan: RelationshipRecipients = {
      targets,
      highlights: !collection,
      watches: created ? [] : [target],
      except: actor ? [actor] : [],
      languages,
    };
    const recipients = await relationshipRecipients(access, relationshipPlan);
    return recipients.length
      ? {
          sourceOwner: 'graph',
          sourceEvent: created ? `work-public:${target}` : envelope.id,
          purpose: 'subscription',
          topic: created ? 'new-work' : collection ? 'collection-change' : 'new-release',
          subject: { owner: 'graph', ref: target, revision: null },
          disclosureBasis: 'relationship-resource-v1',
          recipients,
          relationshipPlan,
        }
      : null;
  } catch (error) {
    if (error instanceof WorkReadMissing) return null;
    throw error;
  }
}
export function resourceNotificationSubjectReader(
  access: Pool,
  env: WorkActivationEnvironment,
): NotificationSubjectReader {
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (input.owner !== 'graph' || input.disclosureBasis !== 'relationship-resource-v1')
        return { status: 'undisclosed' };
      try {
        if (input.topic === 'collection-change') {
          const summary = await collectionProof(env.fuseki, input.ref);
          if (
            !summary ||
            !(await relationshipEligible(access, input.principalId, {
              targets: [input.ref],
              highlights: false,
              watches: [input.ref],
            }))
          )
            return { status: 'undisclosed' };
          const after = await collectionProof(env.fuseki, input.ref);
          if (!after || JSON.stringify(after) !== JSON.stringify(summary))
            return { status: 'undisclosed' };
          return {
            status: 'available',
            subject: {
              private: false,
              fields: { linkTarget: input.ref, title: summary.name.value },
            },
          };
        }
        return await targetRead(env, {}, async (session) => {
          const target = (await resolveTargets(session, [input.ref], 'discussion'))[0]!;
          const work = target.work ?? (target.base === 'work' ? target.resource : null);
          if (!work) return { status: 'undisclosed' };
          const targets = await interestTargets(env.fuseki, target.resource, work);
          const languages =
            target.base === 'release'
              ? await releaseLanguages(env.fuseki, target.resource, work)
              : [];
          const eligible = () =>
            relationshipEligible(access, input.principalId, {
              targets,
              highlights: true,
              watches: target.base === 'release' ? [target.resource] : [],
              languages,
            });
          if (!(await eligible())) return { status: 'undisclosed' };
          const title = await notificationWorkTitle(env, work);
          if (!(await eligible())) return { status: 'undisclosed' };
          return {
            status: 'available',
            subject: {
              private: false,
              fields: {
                linkTarget: work,
                ...(target.base === 'release' ? { release: target.resource } : {}),
                ...(title ? { title } : {}),
              },
            },
          };
        });
      } catch (error) {
        if (error instanceof WorkReadMissing) return { status: 'undisclosed' };
        throw error;
      }
    },
  };
}
export const RESOURCE_NOTIFICATION_COST = {
  targets: 5,
  primaryAuthors: 3,
  currentTargets: 1,
  recipients: 256,
} as const;
