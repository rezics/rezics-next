import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/ai-hub.md', [
  {
    id: 'HUB01',
    scenario: 'Import current Skill directory and manifest',
    requiredResult: 'Preserve files/declarations; missing requirements explicit.',
  },
  {
    id: 'HUB02',
    scenario: 'Edit Prompt parameters/examples',
    requiredResult: 'Exact revisions and schema applicability retained.',
  },
  {
    id: 'HUB03',
    scenario: 'Resolve Skill package dependencies',
    requiredResult: 'Use ecosystem profiles and concrete artifact lock.',
  },
  {
    id: 'HUB04',
    scenario: 'Ingest malicious instruction text',
    requiredResult: 'No execution or secret/network authority.',
  },
  {
    id: 'HUB05',
    scenario: 'MCP server changes tool schema/capabilities',
    requiredResult: 'Observed version drift; no silently widened consent.',
  },
  {
    id: 'HUB06',
    scenario: 'Invoke controlled protocol cases',
    requiredResult: 'Pagination, errors, cancellation and delegated scopes preserved.',
  },
]);
