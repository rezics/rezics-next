import { GRAPHS, RV, iri } from '../work/activate.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { readChangedEvent } from '../semantic/outbox-event.ts';

export const outboxEventHandlers: OwnerOutboxEventHandler[] = [{
  kind: `${RV}RelationChangedEvent`, action: 'relation.change', type: 'com.rezics.relation.changed.v1',
  read: input => readChangedEvent(input, 'relation.change', 'relation-change', ['RelationOccurrenceRevision'],
    'com.rezics.relation.changed.v1', async (component, revision): Promise<{ scope: string; fields: Record<string, string> }> => {
      const scope = input.value('scope')!;
      if (!scope.startsWith('work:edit:')) {
        return { scope: input.value('expectedHead') ? `relation:edit:${component}` : 'relation:create:root', fields: {} };
      }
      const work = scope.slice('work:edit:'.length);
      if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) {
        throw new Error('relation event has an invalid Work scope');
      }
      // Prove participation in the retained revision, independent of the current
      // occurrence head or Work lifecycle when the ordered relay catches up.
      const result = await input.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RelationOccurrenceRevision ;
          rv:component ${iri(component)} ; rv:participation ?participation .
          ?participation rv:participant ${iri(work)} } }`);
      if (result.boolean !== true) throw new Error('relation event Work is not a retained participant');
      return { scope, fields: { work } };
    }),
}];
