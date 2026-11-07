import { characterDocumentProperties } from '../../semantic/character-public-reading-documents.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import {
  readItemDetails,
  readItemTypes,
  readSubjectPageStates,
} from '../../semantic/public-subject-facts.ts';
import { globalReadEligibility, relatedReadEligibility } from '../../semantic/character-public-reading-documents.ts';
import { withReadTransaction } from '../../semantic/read.ts';
import { selectPage as selectNativePage, guardSelectedPage as guardNativePage } from '../selected-page.ts';
import {
  activateProfile,
  activeProfile,
  bootstrapProfile,
  publishProfile,
  readProfile,
} from '../profiles.ts';
import { PageReadBudget, readPage } from '../reads.ts';
import type { PageApplicationPorts, PageSemanticPort } from '../page-semantic-port.ts';
import type { PageExecution, SelectedPageSnapshot } from '../page-contract.ts';

/** Public Semantic producers for configured-page document bindings and metadata observation. */
export function createNativePageSemanticPort(): PageSemanticPort {
  return Object.freeze({
    characterDocumentProperties,
    activeRelease,
    readItemTypes,
    readItemDetails,
    readSubjectPageStates,
    globalReadEligibility,
    relatedReadEligibility,
    withReadTransaction,
  });
}

function selectedAuthority(execution: PageExecution) {
  return {
    deps: {
      pool: execution.pool,
      access: execution.access,
      routeKey: execution.routeKey,
      clock: execution.clock,
      deadlineNow: execution.deadlineNow,
    },
    actor: execution.actor,
    deadline: execution.deadline,
    run: execution.run,
    record: execution.record,
  };
}

/** Bind Semantic, selected-context/publication, profile and page-read producers for one application. */
export function createNativePagePorts(): PageApplicationPorts {
  return Object.freeze({
    semantic: createNativePageSemanticPort(),
    selected: Object.freeze({
      async selectPage(execution: PageExecution, realmId: string, subject: string): Promise<SelectedPageSnapshot> {
        const selected = await selectNativePage(selectedAuthority(execution), realmId, subject);
        return {
          context: selected.context,
          realm: {
            realmId: selected.realm.realmId,
            contextId: selected.realm.contextId,
            headRevisionId: selected.realm.headRevisionId,
            title: selected.realm.title,
          },
          publication: selected.publication ? { publicationId: selected.publication.publicationId } : null,
          subject: selected.subject,
        };
      },
      async guardSelectedPage(execution: PageExecution, selected: SelectedPageSnapshot): Promise<void> {
        await guardNativePage(selectedAuthority(execution), selected);
      },
    }),
    profiles: Object.freeze({
      activeProfile,
      readProfile,
      publishProfile,
      activateProfile,
      bootstrapProfile,
    }),
    pageRead: Object.freeze({
      readPage,
      createBudget: () => new PageReadBudget(),
    }),
  });
}
