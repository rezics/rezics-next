import { expect, test } from 'bun:test';
import { integrationStackAdmitsWorkScope } from './stack-environment.ts';
import { rawSparqlIntegrationFiles } from './isolated-integration-files.ts';

const discoveryReplay = 'tests/qa/integration/discovery-read-isolation.test.ts';
const commandOnly = 'tests/qa/integration/profile-corpus-restore.test.ts';

test('discovery replay selects the fixture assembler through the derived raw-update scan', () => {
  expect(rawSparqlIntegrationFiles().has(discoveryReplay)).toBe(true);
  expect(integrationStackAdmitsWorkScope([discoveryReplay], false)).toBe(false);
});

test('command-only files keep the exclusive assembler unless raw maintenance is requested', () => {
  expect(rawSparqlIntegrationFiles().has(commandOnly)).toBe(false);
  expect(integrationStackAdmitsWorkScope([commandOnly], false)).toBe(true);
  expect(integrationStackAdmitsWorkScope([commandOnly], true)).toBe(false);
});
