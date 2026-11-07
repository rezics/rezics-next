import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createVerificationApplication, VerificationSubjectSearch } from '../src/settings/application/verification';
import { eligibleVerificationSubjects, validateVerificationDraft } from '../src/settings/core/verification';
import { nativeVerificationCopy } from '../src/settings/adapters/verification';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';
import type { VerificationOperations } from '../src/settings/contract/verification';

const settingsAmbient = createBrowserSettingsAmbient();

const contract = readFileSync(new URL('../src/settings/contract/verification.ts', import.meta.url), 'utf8');
const core = readFileSync(new URL('../src/settings/core/verification.ts', import.meta.url), 'utf8');
const application = readFileSync(new URL('../src/settings/application/verification.ts', import.meta.url), 'utf8');

test('verification application and core load over supplied operations without private Search, Content, session or platform implementations', async () => {
  for (const source of [contract, core, application]) {
    expect(source).not.toContain('search/search-recovery-retry');
    expect(source).not.toContain('search/suggestions');
    expect(source).not.toContain('media/kernel');
    expect(source).not.toContain('session/request');
    expect(source).not.toContain('session/query');
    expect(source).not.toContain('kernel/platform-closed');
  }
  const draft = {
    subject: 'subject-1',
    statement: 'This is me.',
    links: [{ label: 'Homepage', url: 'https://example.test' }],
  };
  expect(validateVerificationDraft(draft)).toEqual([]);
  expect(
    eligibleVerificationSubjects(
      [{ id: 'Author', type: 'Author', labels: { en: 'Avery' }, summary: null }],
      { types: { Author: { bases: ['schema:Person'] }, 'schema:Person': { bases: [] } } },
      { person: 'Person', organization: 'Organization' },
    ),
  ).toEqual([{ id: 'Author', title: 'Avery', type: 'Person' }]);
  const calls: string[] = [];
  const operations: VerificationOperations = {
    status: async (accountId) => {
      calls.push(`status:${accountId}`);
      return {
        verificationRequest: null,
        viewerActions: [{ action: 'account:update', operations: ['account.request_verification'] }],
      };
    },
    request: async () => {
      throw new Error('Unexpected request');
    },
    withdraw: async () => {
      throw new Error('Unexpected withdraw');
    },
    eligibility: async () => ({ types: { 'schema:Person': { bases: [] } } }),
    title: async () => 'Avery',
    suggest: async (query) => {
      calls.push(`suggest:${query}`);
      return [{ id: 'person-1', type: 'schema:Person', labels: { en: 'Avery' }, summary: null }];
    },
  };
  const composed = createVerificationApplication(operations, nativeVerificationCopy(), settingsAmbient);
  expect(await composed.searchEligible('Avery', ['en'], new AbortController().signal)).toEqual([
    { id: 'person-1', title: 'Avery', type: nativeVerificationCopy().person },
  ]);
  const recovery = composed.recover('alice', {
    read: async (accountId) => ({
      accountId,
      ...(await operations.status(accountId)),
      subjectTitle: null,
    }),
    request: async () => {
      throw new Error('Unexpected request');
    },
    withdraw: async () => {
      throw new Error('Unexpected withdraw');
    },
  });
  await recovery.reload();
  expect(recovery.snapshot().phase).toBe('idle');
  expect(recovery.snapshot().current?.viewerActions[0]?.operations).toEqual(['account.request_verification']);
  const search = new VerificationSubjectSearch(async () => ({ ok: true, value: [] }), settingsAmbient);
  search.setEnabled(true);
  search.edit('Avery');
  expect(search.snapshot().query).toBe('Avery');
  search.setEnabled(false);
  expect(calls).toEqual(['suggest:Avery', 'status:alice']);
});
