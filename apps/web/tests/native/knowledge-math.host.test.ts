import { afterAll, setDefaultTimeout } from 'bun:test';
import { documentText, parseDocument } from '@rezics/document';
import type { Locator } from 'playwright';
import { expect } from 'playwright/test';
import { knowledgeExactHref } from '../../src/knowledge/public-read';
import { referenceCopy } from '../../src/knowledge/reference-copy';
import { m } from '../../src/paraglide/messages.js';
import {
  knowledgeJourneyCopy,
  startKnowledgeJourneyFixture,
  type KnowledgeJourneyFixture,
} from './knowledge-journey-fixture.ts';
import { exact, mathApi, mathDocument, snapshot, uses } from './knowledge-math-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

setDefaultTimeout(600_000);
const lifecycle = new NativeTestLifecycle('native Knowledge mathematical learning');
const workbench = knowledgeJourneyCopy();
const reader = referenceCopy('en');
let fixture: KnowledgeJourneyFixture;

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await startKnowledgeJourneyFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

async function keyboardOpen(reference: Locator) {
  const link = reference.getByRole('link', { name: reader.open, exact: true });
  await link.focus();
  await expect(link).toBeFocused();
  await link.press('Enter');
}

nativeTest(
  'two mathematical solutions retain their own exact steps through revision, reuse and withdrawal',
  600_000,
  async () => {
    const api = mathApi(fixture);
    const { alice, bob } = fixture;
    const subjectId = await api.subject('Convergence and boundedness');
    const ownerTitle = 'Private convergence research';
    const noteTitle = 'Private misunderstanding of the tail estimate';
    const originalAssumption = String.raw`Assume \varepsilon>0 and x_n\to L in \mathbb{R}. Eventually |x_n-L|<\varepsilon.`;
    const changedAssumption = String.raw`Assume \varepsilon=1 and x_n\to L in \mathbb{R}. The tail is bounded by |L|+1.`;
    const definitionText = String.raw`Bounded means that there exists M such that |x_n|\le M for all n.`;
    const firstStep = 'Bound the tail using convergence, then take a maximum over the finite prefix.';
    const secondStep = 'Split the prefix and tail and use the definition directly to give a single bound.';

    // Native setup uses ordinary Semantic and Content commands for five separate documents.
    const notebook = await api.notebook('alice', subjectId, ownerTitle);
    const problem = await api.create(
      'alice',
      notebook,
      mathDocument('Problem', 'problem', 'Show that every convergent real sequence is bounded.'),
    );
    const definition = await api.create(
      'alice',
      notebook,
      mathDocument('Bounded sequence', 'definition', definitionText),
    );
    const definitionPublication = await api.select(definition, null);
    const definitionV1 = await api.publicRead('anonymous', definition.documentId, definition.revisionId);
    const definitionCitation = exact(definitionV1, 'definition');
    const theoremUses = uses('theorem-uses-definition', 'assumptions', definitionCitation);
    const theorem = await api.create(
      'alice',
      notebook,
      mathDocument('Convergent sequences', 'assumptions', originalAssumption, theoremUses),
    );
    const theoremPublication = await api.select(theorem, null);
    const theoremV1 = await api.publicRead('anonymous', theorem.documentId, theorem.revisionId);
    const theoremCitation = exact(theoremV1, 'assumptions');
    const firstUses = uses('tail-uses-theorem', 'tail-step', theoremCitation);
    const secondUses = uses('maximum-uses-definition', 'maximum-step', definitionCitation);
    const first = await api.create(
      'alice',
      notebook,
      mathDocument('Solution by convergence', 'tail-step', firstStep, firstUses),
    );
    const second = await api.create(
      'alice',
      notebook,
      mathDocument('Solution by a common bound', 'maximum-step', secondStep, secondUses),
    );
    await api.select(problem, null);
    await api.select(first, null);
    await api.select(second, null);

    const firstV1 = await api.publicRead('anonymous', first.documentId, first.revisionId);
    const secondV1 = await api.publicRead('bob', second.documentId, second.revisionId);
    expect((await api.publicRead('bob', problem.documentId)).references).toEqual([]);
    expect(firstV1.references).toEqual([firstUses]);
    expect(secondV1.references).toEqual([secondUses]);
    expect(theoremV1.references).toEqual([theoremUses]);

    // Each viewer gets only their own attached notebooks alongside the same public source.
    const bobNotebook = await api.notebook('bob', subjectId, 'Private learner notebook');
    const note = await api.create(
      'bob',
      bobNotebook,
      mathDocument(noteTitle, 'learner-step', 'Why can the tail use the same bound?'),
    );
    const ownedNote = await api.privateRead('bob', bob.accountId, bobNotebook, note);
    expect(ownedNote.cache).toContain('no-store');
    expect(ownedNote.value.document.references).toEqual([]);
    expect((await api.attached('bob', bob.accountId, subjectId)).value).toMatchObject({
      notebooks: [{ notebookId: bobNotebook.notebookId }],
      next: null,
    });
    expect((await api.attached('alice', alice.accountId, subjectId)).value).toMatchObject({
      notebooks: [{ notebookId: notebook.notebookId }],
      next: null,
    });
    for (const persona of ['alice', 'moderator', 'anonymous'] as const) {
      const denial = await api.privateRead(
        persona,
        bob.accountId,
        bobNotebook,
        note,
        persona === 'anonymous' ? [401, 403, 404] : 404,
      );
      expect(denial.raw).not.toContain(noteTitle);
    }
    for (const persona of ['alice', 'bob', 'moderator', 'anonymous'] as const) {
      expect((await api.unavailable(persona, note, true)).raw).not.toContain(noteTitle);
      const publicRow = await api.publicRead(persona, first.documentId, first.revisionId);
      expect(publicRow).toEqual(firstV1);
      for (const secret of [noteTitle, bobNotebook.notebookId, note.documentId, ownerTitle, notebook.notebookId]) {
        expect(JSON.stringify(publicRow)).not.toContain(secret);
      }
      const publicExport = await api.export(persona, first);
      expect(publicExport.cache).toContain('no-store');
      expect(publicExport.value.references).toEqual([firstUses]);
      expect(publicExport.raw).not.toContain(noteTitle);
      expect(publicExport.raw).not.toContain(bobNotebook.notebookId);
    }

    const firstHref = knowledgeExactHref('en', first.documentId, first.revisionId, exact(firstV1, 'tail-step'));
    for (const persona of ['anonymous', 'bob'] as const) {
      const response = await fixture.stack.request(firstHref, persona);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(firstStep);
      expect(html).not.toContain(noteTitle);
      expect(html).not.toContain(bobNotebook.notebookId);
    }

    const signedIn = await fixture.auth.signIn('bob');
    const page = await signedIn.context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    page.setDefaultTimeout(60_000);
    const main = page.getByRole('main');

    // A visit reads one public source. The preview is deliberate and does not mount the theorem's outbound controls.
    const firstReference = main.locator('[data-reference-id="tail-uses-theorem"]');
    const theoremReference = main.locator('[data-reference-id="theorem-uses-definition"]');
    const publicReadPaths = () =>
      fixture.stack.kernelRequests().flatMap((record) => {
        const url = new URL(record.url, fixture.stack.kernelOrigin);
        return !record.fixtureRequest && record.method === 'GET' && url.pathname.startsWith('/v1/knowledge/documents/')
          ? [url.pathname + url.search]
          : [];
      });
    await fixture.stack.refreshKernelRequests();
    const openStart = publicReadPaths().length;
    await fixture.open(page, firstHref);
    await expect(main.getByText(firstStep, { exact: true })).toBeInViewport();
    await expect(main).not.toContainText(noteTitle);
    await fixture.stack.refreshKernelRequests();
    const firstReads = publicReadPaths().slice(openStart);
    expect([...new Set(firstReads)]).toEqual([
      `/v1/knowledge/documents/${first.documentId}?revisionId=${first.revisionId}`,
    ]);

    const inspect = firstReference.getByRole('button', { name: reader.inspect, exact: true });
    await inspect.focus();
    await inspect.press('Enter');
    await expect(main.getByText(originalAssumption, { exact: true })).toBeVisible();
    await expect(theoremReference).toHaveCount(0);
    await expect(main).not.toContainText(definitionText);
    await fixture.stack.refreshKernelRequests();
    expect([...new Set(publicReadPaths().slice(openStart + firstReads.length))]).toEqual([
      `/v1/knowledge/documents/${theorem.documentId}?revisionId=${theorem.revisionId}`,
    ]);
    await main.getByRole('button', { name: reader.close, exact: true }).press('Enter');
    await keyboardOpen(firstReference);
    await expect(main.getByText(originalAssumption, { exact: true })).toBeVisible();
    await fixture.hydrate(page);
    await keyboardOpen(theoremReference);
    await expect(main.getByText(definitionText, { exact: true })).toBeVisible();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(main.getByText(originalAssumption, { exact: true })).toBeVisible();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new URL(firstHref, fixture.stack.web).href);
    await expect(main.getByText(firstStep, { exact: true })).toBeInViewport();
    const secondHref = knowledgeExactHref('en', second.documentId, second.revisionId, exact(secondV1, 'maximum-step'));
    await fixture.open(page, secondHref);
    await expect(main.getByText(secondStep, { exact: true })).toBeVisible();
    await expect(firstReference).toHaveCount(0);
    await keyboardOpen(main.locator('[data-reference-id="maximum-uses-definition"]'));
    await expect(main.getByText(definitionText, { exact: true })).toBeVisible();

    // Reuse the same theorem revision from a separate account's Workbench, then read back the saved manifest.
    await fixture.open(page, fixture.privateHref(bobNotebook.notebookId, note.documentId));
    await expect(page.getByLabel(workbench.documentTitle, { exact: true })).toHaveValue(noteTitle);
    await expect(page.locator('.ProseMirror')).toContainText('Why can the tail use the same bound?');
    await main.getByRole('button', { name: reader.add, exact: true }).press('Enter');
    const entry = main.getByRole('group', { name: reader.edit, exact: true });
    async function choose(field: string, option: string) {
      await entry.getByRole('combobox', { name: field, exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    }
    await choose(reader.kind, reader.exact);
    await choose(reader.role, reader.roles.uses);
    await choose(reader.sourceBlock, 'learner-step');
    await entry.getByLabel(reader.documentId, { exact: true }).fill(theoremCitation.documentId);
    await entry.getByLabel(reader.revisionId, { exact: true }).fill(theoremCitation.revisionId);
    await entry.getByLabel(reader.digest, { exact: true }).fill(theoremCitation.sha256);
    await entry.getByLabel(reader.blockId, { exact: true }).fill(theoremCitation.blockId!);
    await entry.getByLabel(reader.label, { exact: true }).fill('Use the original tail assumption');
    await entry.getByRole('button', { name: reader.apply, exact: true }).press('Enter');
    await page.getByRole('button', { name: workbench.save, exact: true }).press('Enter');
    await fixture.waitStatus(page, workbench.readbackConfirmed);
    const savedNote = (await api.privateRead('bob', bob.accountId, bobNotebook, note)).value.document;
    expect(savedNote.revisionId).not.toBe(note.revisionId);
    expect(savedNote.references).toMatchObject([
      { role: 'uses', sourceBlockId: 'learner-step', target: theoremCitation },
    ]);
    const noteUses = savedNote.references[0]!;
    expect((await api.publicRead('anonymous', first.documentId, first.revisionId)).references).toEqual([firstUses]);
    await api.unavailable('anonymous', savedNote, true);

    // A private intermediate head stays concealed. Live selection advances independently of both exact uses.
    const draft = await api.revise(
      theorem,
      mathDocument('Private assumption draft', 'assumptions', 'Consider a counterexample first.'),
    );
    expect((await api.publicRead('bob', theorem.documentId)).revisionId).toBe(theorem.revisionId);
    await api.unavailable('bob', draft, true);
    const theoremLive = await api.revise(
      draft,
      mathDocument(
        'Convergence with a unit tail bound',
        'assumptions',
        changedAssumption,
        uses('current-theorem-uses-definition', 'assumptions', { kind: 'document', documentId: definition.documentId }),
      ),
    );
    const currentPublication = await api.select(theoremLive, theoremPublication);
    expect(currentPublication).not.toBe(theoremPublication);
    expect(await api.publicRead('bob', theorem.documentId)).toMatchObject({
      revisionId: theoremLive.revisionId,
      publicationId: currentPublication,
    });
    expect((await api.publicRead('bob', first.documentId, first.revisionId)).references).toEqual([firstUses]);
    expect((await api.privateRead('bob', bob.accountId, bobNotebook, note)).value.document.references).toEqual([
      noteUses,
    ]);
    const exported = (await api.export('anonymous', theorem)).value;
    expect(exported.selection).toMatchObject({ revisionId: theorem.revisionId, sourceSha256: theoremCitation.sha256 });
    expect(documentText(parseDocument(exported.snapshot))).toContain(originalAssumption);
    expect(documentText(snapshot(theoremV1))).toContain(originalAssumption);

    await fixture.open(page, firstHref);
    await keyboardOpen(firstReference);
    await expect(main.getByText(originalAssumption, { exact: true })).toBeVisible();
    await expect(main).not.toContainText(changedAssumption);
    await main.getByRole('link', { name: m.knowledge_current_open(), exact: true }).press('Enter');
    await expect(main.getByText(changedAssumption, { exact: true })).toBeVisible();

    // Follow an actual two-document live cycle. Each full visit still displays only one selected source.
    const definitionLive = await api.revise(
      definition,
      mathDocument(
        'Bounded sequence with an application',
        'definition',
        definitionText,
        uses('definition-uses-current-theorem', 'definition', { kind: 'document', documentId: theorem.documentId }),
      ),
    );
    await api.select(definitionLive, definitionPublication);
    await keyboardOpen(main.locator('[data-reference-id="current-theorem-uses-definition"]'));
    await expect(main.getByText(definitionText, { exact: true })).toBeVisible();
    await expect(main).not.toContainText(changedAssumption);
    await fixture.hydrate(page);
    await keyboardOpen(main.locator('[data-reference-id="definition-uses-current-theorem"]'));
    await expect(main.getByText(changedAssumption, { exact: true })).toBeVisible();

    // Native source withdrawal takes effect on direct reads, exports and managed targets independently of discovery.
    expect(await api.select(theoremLive, currentPublication, null)).toBeNull();
    const ownerHead = (await api.privateRead('alice', alice.accountId, notebook, theoremLive)).value.document;
    expect(ownerHead.revisionId).toBe(theoremLive.revisionId);
    expect(documentText(snapshot(ownerHead))).toContain(changedAssumption);
    for (const persona of ['bob', 'moderator', 'anonymous'] as const) {
      await api.unavailable(persona, theorem, true);
      await api.unavailable(persona, theoremLive, false);
      await api.unavailable(persona, theorem, true, true);
      const projected = await api.publicRead(persona, first.documentId, first.revisionId);
      expect(projected.references).toEqual([{ ...firstUses, target: null }]);
      expect(documentText(snapshot(projected))).toContain(firstStep);
      const result = await api.export(persona, first);
      expect(result.value.references).toEqual([{ ...firstUses, target: null }]);
      for (const secret of [
        theorem.documentId,
        theorem.revisionId,
        theoremCitation.sha256,
        'assumptions',
        originalAssumption,
      ]) {
        expect(JSON.stringify(projected)).not.toContain(secret);
        expect(result.raw).not.toContain(secret);
      }
    }
    await fixture.open(page, firstHref);
    await expect(firstReference.getByText(reader.unavailable, { exact: true })).toBeVisible();
    await expect(firstReference.getByRole('link')).toHaveCount(0);
    await expect(firstReference.getByRole('button')).toHaveCount(0);
    await expect(main.getByText(firstStep, { exact: true })).toBeVisible();
    expect((await api.publicRead('bob', second.documentId, second.revisionId)).references).toEqual([secondUses]);
    expect((await api.privateRead('bob', bob.accountId, bobNotebook, note)).value.document.references).toEqual([
      noteUses,
    ]);

    const reopened = await api.select(theoremLive, null);
    expect(reopened).toBeTruthy();
    expect(reopened).not.toBe(currentPublication);
    expect((await api.publicRead('bob', theorem.documentId)).revisionId).toBe(theoremLive.revisionId);
    await api.unavailable('bob', theorem, true);
    expect((await api.publicRead('bob', first.documentId, first.revisionId)).references).toEqual([
      { ...firstUses, target: null },
    ]);
  },
  lifecycle,
);
