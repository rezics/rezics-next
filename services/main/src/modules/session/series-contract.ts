import { t } from 'elysia';
import { readId, readLanguage } from '../work/read-contract.ts';
import { sessionLocator } from './contract.ts';
import { editionChoice, editionPreference } from './preference-contract.ts';
import { SERIES_COST, SERIES_POLICY } from './series-policy.ts';

const part = t.Object({ occurrence: readId, work: readId, displayLabel: t.String(),
  inclusion: t.Union([t.Literal('required'), t.Literal('optional'), t.Literal('extra')]), available: t.Boolean() });
const pin = t.Object({ resource: readId, revision: readId });
export const seriesSummary = t.Object({ resource: readId, scope: t.Literal('disclosed-composition'),
  policy: t.Literal(SERIES_POLICY), language: readLanguage,
  completedParts: t.Array(part, { maxItems: SERIES_COST.parts }),
  counts: t.Object({ completed: t.Integer(), required: t.Integer(), completedRequired: t.Integer() }),
  states: t.Object({ caughtUpWithAvailableMaterial: t.Nullable(t.Boolean()),
    finishedPublishedParts: t.Nullable(t.Boolean()), seriesConcluded: t.Nullable(t.Boolean()),
    correspondenceUnresolved: t.Boolean() }),
  next: t.Nullable(t.Object({ part, reason: t.Union([t.Literal('next_available_required_part'),
    t.Literal('awaiting_chosen_language'), t.Literal('optional_extra')]) })),
  furthestCompleted: t.Nullable(t.Object({ part, occurrence: t.Nullable(pin), locator: t.Nullable(sessionLocator) })),
  partial: t.Boolean(), preference: t.Nullable(editionPreference),
  primaryAction: t.Nullable(t.Object({ work: readId, edition: editionChoice.properties.edition, language: readLanguage })),
  revisions: t.Object({ composition: t.Object({ structure: readId, revision: readId }),
    sessions: t.Array(t.Object({ id: readId, version: t.Integer() }), { maxItems: SERIES_COST.sessions }),
    library: t.Array(t.Object({ work: readId, version: t.Integer() }), { maxItems: SERIES_COST.parts }),
    selections: t.Array(pin, { maxItems: SERIES_COST.selectionPins }),
    graph: t.Object({ dataEpoch: t.String(), sequence: t.String() }) }),
  continuation: t.Object({ parts: t.Nullable(t.String()), groups: t.Array(readId),
    sessions: t.Nullable(t.String()), releases: t.Nullable(t.String()) }) });
