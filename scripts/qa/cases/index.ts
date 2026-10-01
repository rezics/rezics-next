import { cases as ai_hub } from './ai-hub.ts';
import { cases as backend_integration } from './backend-integration.ts';
import { cases as book_and_creation } from './book-and-creation.ts';
import { cases as classification } from './classification.ts';
import { cases as content_composition } from './content-composition.ts';
import { cases as governance_and_delivery } from './governance-and-delivery.ts';
import { cases as identity_and_access } from './identity-and-access.ts';
import { cases as information_verification } from './information-verification.ts';
import { cases as launch_safety } from './launch-safety.ts';
import { cases as model_contracts } from './model-contracts.ts';
import { cases as native_work } from './native-work.ts';
import { cases as operations } from './operations.ts';
import { cases as packages } from './packages.ts';
import { cases as presentation_and_addressing } from './presentation-and-addressing.ts';
import { cases as ratings_and_event_time } from './ratings-and-event-time.ts';
import { cases as recipes } from './recipes.ts';
import { cases as recommendations } from './recommendations.ts';
import { cases as relationship_graph } from './relationship-graph.ts';
import { cases as search } from './search.ts';
import { cases as source_conformance } from './source-conformance.ts';
import { cases as subscriptions_and_pro } from './subscriptions-and-pro.ts';
import { cases as wiki_composition } from './wiki-composition.ts';
import type { DeclaredCase } from './types.ts';

export const declaredCases: readonly DeclaredCase[] = [
  ai_hub,
  backend_integration,
  book_and_creation,
  classification,
  content_composition,
  governance_and_delivery,
  identity_and_access,
  information_verification,
  launch_safety,
  model_contracts,
  native_work,
  operations,
  packages,
  presentation_and_addressing,
  ratings_and_event_time,
  recipes,
  recommendations,
  relationship_graph,
  search,
  source_conformance,
  subscriptions_and_pro,
  wiki_composition,
]
  .flat()
  .sort((a, b) => a.id.localeCompare(b.id));
