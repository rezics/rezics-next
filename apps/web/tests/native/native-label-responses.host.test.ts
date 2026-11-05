import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
  NATIVE_LABEL_RESPONSE_HEADERS,
  NATIVE_LABEL_RESPONSE_MANIFEST,
  createNativeLabelResponsesFixture,
  type NativeLabelResponseRecord,
  type NativeLabelResponsesFixture,
} from './native-label-responses-fixture.ts';

setDefaultTimeout(300_000);

let fixture: NativeLabelResponsesFixture;

beforeAll(async () => {
  fixture = await createNativeLabelResponsesFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

function response(scenario: keyof NativeLabelResponsesFixture['responses']): NativeLabelResponseRecord {
  const value = fixture.responses[scenario];
  expect(value.availability).toBe('available');
  return value;
}

function json<T>(scenario: keyof NativeLabelResponsesFixture['responses']): T {
  return JSON.parse(response(scenario).bodyText) as T;
}

function command(scenario: string) {
  const found = fixture.commandSequence.find((item) => item.step === scenario);
  expect(found, `native command ${scenario} is captured`).toBeDefined();
  return found!;
}

function rowForLabel(
  scenario: keyof NativeLabelResponsesFixture['responses'],
  labelId: string,
): { id: string; labelId: string; subjectId: string; revision: number; label: { name: string } } | undefined {
  const body = json<{
    assignments: { id: string; labelId: string; subjectId: string; revision: number; label: { name: string } }[];
  }>(scenario);
  return body.assignments.find((item) => item.labelId === labelId);
}

const labelFrom = (scenario: keyof NativeLabelResponsesFixture['responses']) =>
  json<{ label: { id: string; revision: number } }>(scenario).label;

function routePattern(route: string): RegExp {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, '[^/?&]+')}$`);
}

test('exports a closed native response map bound to source, runtime and original commands', () => {
  expect(fixture.manifest).toEqual(NATIVE_LABEL_RESPONSE_MANIFEST);
  expect(fixture.sourceBuild.source.revision).toMatch(/^[0-9a-f]{40}$/i);
  expect(fixture.sourceBuild.build.runtime).toBe('Bun');
  expect(fixture.sourceBuild.build.runtimeVersion.length).toBeGreaterThan(0);
  expect(fixture.sourceBuild.currentDevRecording).toBe(
    fixture.sourceBuild.source.revision !== null && fixture.sourceBuild.source.clean === true,
  );

  const expectedScenarios = fixture.manifest.map(({ scenario }) => scenario).sort();
  expect(Object.keys(fixture.responses).sort()).toEqual(expectedScenarios);
  for (const descriptor of fixture.manifest) {
    const observed = response(descriptor.scenario);
    const request = command(descriptor.scenario);
    expect(observed).toMatchObject({
      scenario: descriptor.scenario,
      routeState: descriptor.routeState,
      method: descriptor.method,
      persona: descriptor.persona,
      sourceBuild: fixture.sourceBuild,
    });
    expect(observed.path).toMatch(routePattern(descriptor.route));
    expect(observed.bodyText).toEqual(expect.any(String));
    expect(observed).not.toHaveProperty('body');
    expect(request).toMatchObject({
      sequence: observed.commandSequence,
      method: observed.method,
      path: observed.path,
      persona: observed.persona,
    });
    expect(
      Object.keys(observed.responseHeaders).every((name) =>
        (NATIVE_LABEL_RESPONSE_HEADERS as readonly string[]).includes(name),
      ),
    ).toBe(true);
  }

  expect(fixture.supportingResponses.exposurePersonalLibrary.status).toBe(200);
  expect(fixture.supportingResponses.exposureReadingProgress.status).toBe(200);
  expect(fixture.auth).toEqual({ signedInPersonas: ['alice', 'bob'], suspendedPersona: 'suspended' });
  expect(
    fixture.commandSequence.every(
      (item) =>
        !/authorization|cookie|csrf|signature|bearer|token/i.test(
          `${item.step} ${item.path} ${item.requestBodyText ?? ''}`,
        ),
    ),
  ).toBe(true);
});

test('retains exact owner catalogue and subject assignment pages, mutations and ordinary Undo inputs', () => {
  const createAlpha = labelFrom('owner.label.create.alpha');
  const createBeta = labelFrom('owner.label.create.beta');
  const createLong = labelFrom('owner.label.create.long');
  const rename = labelFrom('owner.label.rename.beta');
  expect(rename.id).toBe(createBeta.id);

  for (const scenario of ['owner.label.create.alpha', 'owner.label.create.beta', 'owner.label.create.long'] as const) {
    const body = JSON.parse(response(scenario).bodyText) as { label: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['label']);
    expect(Object.keys(body.label).sort()).toEqual(['id', 'revision']);
    expect(response(scenario).bodyText).not.toContain(fixture.seed.names.long);
  }
  expect(command('owner.label.create.long').requestBodyText).toBe(JSON.stringify({ name: fixture.seed.names.long }));
  expect(Array.from(fixture.seed.names.long)).toHaveLength(100);

  const renameInput = JSON.parse(command('owner.label.rename.beta').requestBodyText!) as {
    name: string;
    revision: number;
  };
  expect(renameInput).toEqual({ name: fixture.seed.names.renamedBeta, revision: createBeta.revision });
  expect(rename.revision).toBeGreaterThan(createBeta.revision);

  const firstCatalogue = json<{
    labels: { id: string; name: string; revision: number }[];
    next: string | null;
  }>('owner.catalogue.prefix.first');
  const finalCatalogue = json<{
    labels: { id: string; name: string; revision: number }[];
    next: string | null;
  }>('owner.catalogue.prefix.final');
  expect(firstCatalogue.labels).toHaveLength(2);
  expect(Object.keys(JSON.parse(response('owner.catalogue.prefix.first').bodyText)).sort()).toEqual(['labels', 'next']);
  expect(firstCatalogue.labels.every((label) => Object.keys(label).sort().join(',') === 'id,name,revision')).toBe(true);
  expect(typeof firstCatalogue.next).toBe('string');
  expect(finalCatalogue.labels).toHaveLength(1);
  expect(finalCatalogue.labels.every((label) => Object.keys(label).sort().join(',') === 'id,name,revision')).toBe(true);
  expect(finalCatalogue.next).toBeNull();
  expect([...firstCatalogue.labels, ...finalCatalogue.labels].map(({ name }) => name).sort()).toEqual(
    [fixture.seed.names.alpha, fixture.seed.names.renamedBeta, fixture.seed.names.long].sort(),
  );
  const catalogueRows = [...firstCatalogue.labels, ...finalCatalogue.labels];
  expect(catalogueRows.find(({ name }) => name === fixture.seed.names.alpha)).toMatchObject(createAlpha);
  expect(catalogueRows.find(({ name }) => name === fixture.seed.names.renamedBeta)).toMatchObject(rename);
  expect(catalogueRows.find(({ name }) => name === fixture.seed.names.long)).toMatchObject(createLong);
  for (const scenario of ['owner.catalogue.prefix.first', 'owner.catalogue.prefix.final'] as const) {
    const actual = response(scenario);
    expect(new URL(actual.path, fixture.sourceBuild.build.kernelOrigin).searchParams.get('q')).toBe(
      fixture.seed.prefix,
    );
  }
  const catalogueCursor = firstCatalogue.next!;
  expect(
    new URL(response('owner.catalogue.prefix.final').path, fixture.sourceBuild.build.kernelOrigin).searchParams.get(
      'cursor',
    ),
  ).toBe(catalogueCursor);

  const emptyPrefix = json<{ labels: unknown[]; next: string | null }>('owner.catalogue.empty-prefix');
  expect(emptyPrefix).toEqual({ labels: [], next: null });
  expect(
    new URL(response('owner.catalogue.empty-prefix').path, fixture.sourceBuild.build.kernelOrigin).searchParams.get(
      'q',
    ),
  ).toBe(`${fixture.seed.prefix} no-match`);

  const assignedIds = [
    json<{ assignment: { id: string } }>('owner.assignment.assign.alpha').assignment.id,
    json<{ assignment: { id: string } }>('owner.assignment.assign.beta').assignment.id,
    json<{ assignment: { id: string } }>('owner.assignment.assign.long').assignment.id,
  ].sort();
  for (const scenario of [
    'owner.assignment.assign.alpha',
    'owner.assignment.assign.beta',
    'owner.assignment.assign.long',
  ] as const) {
    const body = JSON.parse(response(scenario).bodyText) as { assignment: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['assignment']);
    expect(Object.keys(body.assignment).sort()).toEqual(['id', 'revision']);
  }
  const firstAssignments = json<{ assignments: unknown[]; next: string | null }>('owner.assignments.subject.first');
  const finalAssignments = json<{ assignments: unknown[]; next: string | null }>('owner.assignments.subject.final');
  expect(firstAssignments.assignments).toHaveLength(2);
  expect(typeof firstAssignments.next).toBe('string');
  expect(finalAssignments.assignments).toHaveLength(1);
  expect(finalAssignments.next).toBeNull();
  const assignmentCursor = firstAssignments.next!;
  expect(
    new URL(response('owner.assignments.subject.final').path, fixture.sourceBuild.build.kernelOrigin).searchParams.get(
      'cursor',
    ),
  ).toBe(assignmentCursor);
  const assignmentRows = [
    ...(firstAssignments.assignments as {
      id: string;
      labelId: string;
      subjectId: string;
      revision: number;
      label: { name: string };
    }[]),
    ...(finalAssignments.assignments as {
      id: string;
      labelId: string;
      subjectId: string;
      revision: number;
      label: { name: string };
    }[]),
  ];
  expect(assignmentRows.map(({ id }) => id).sort()).toEqual(assignedIds);
  expect(
    assignmentRows.every(
      (assignment) =>
        Object.keys(assignment).sort().join(',') === 'id,label,labelId,revision,subjectId' &&
        Object.keys(assignment.label).sort().join(',') === 'name',
    ),
  ).toBe(true);
  expect(assignmentRows.map(({ label }) => label.name).sort()).toEqual(
    [fixture.seed.names.alpha, fixture.seed.names.renamedBeta, fixture.seed.names.long].sort(),
  );
  expect(assignmentRows.every(({ subjectId }) => subjectId === fixture.seed.subjectId)).toBe(true);

  const parentDelete = response('owner.label.delete-parent');
  const parentDeleteInput = command('owner.label.delete-parent');
  expect(parentDelete.status).toBe(200);
  expect(JSON.parse(parentDelete.bodyText)).toEqual({ deleted: true });
  expect(new URL(parentDelete.path, fixture.sourceBuild.build.kernelOrigin).searchParams.get('revision')).toBe(
    String(rename.revision),
  );
  const parentUndoRevision = Number(parentDelete.responseHeaders['library-label-revision']);
  expect(Number.isInteger(parentUndoRevision)).toBe(true);
  const parentRestoreInput = JSON.parse(command('owner.label.restore-parent').requestBodyText!) as { revision: number };
  expect(command('owner.label.restore-parent').path).toBe(`/v1/libraryLabels/${rename.id}:restore`);
  expect(parentRestoreInput).toEqual({ revision: parentUndoRevision });
  expect(command('owner.label.restore-parent').idempotencyKey).toBeTruthy();
  expect(command('owner.label.restore-parent').idempotencyKey).not.toBe(parentDeleteInput.idempotencyKey);
  expect(labelFrom('owner.label.restore-parent').id).toBe(rename.id);

  const betaAssignmentId = assignmentRows.find(({ labelId }) => labelId === createBeta.id)?.id;
  expect(betaAssignmentId).toBeDefined();
  const hiddenAssignments = json<{ assignments: { id: string; labelId: string; label: { name: string } }[] }>(
    'owner.assignments.after-parent-delete',
  );
  expect(
    hiddenAssignments.assignments.some(
      ({ id, labelId, label }) =>
        id === betaAssignmentId || labelId === rename.id || label.name === fixture.seed.names.renamedBeta,
    ),
  ).toBe(false);
  const hiddenCatalogue = json<{ labels: { id: string; name: string }[] }>('owner.catalogue.after-parent-delete');
  expect(
    hiddenCatalogue.labels.some(({ id, name }) => id === rename.id || name === fixture.seed.names.renamedBeta),
  ).toBe(false);
  const restoredAssignments = json<{ assignments: { id: string; labelId: string; label: { name: string } }[] }>(
    'owner.assignments.after-parent-restore',
  );
  expect(
    restoredAssignments.assignments.some(
      ({ id, labelId, label }) =>
        id === betaAssignmentId && labelId === rename.id && label.name === fixture.seed.names.renamedBeta,
    ),
  ).toBe(true);
  expect(
    json<{ labels: { id: string; name: string }[] }>('owner.catalogue.after-parent-restore').labels.some(
      ({ id, name }) => id === rename.id && name === fixture.seed.names.renamedBeta,
    ),
  ).toBe(true);

  const alphaRow = rowForLabel('owner.assignments.after-parent-restore', createAlpha.id);
  expect(alphaRow).toBeDefined();
  const unassignInput = JSON.parse(command('owner.assignment.unassign.alpha').requestBodyText!) as Record<
    string,
    unknown
  >;
  expect(unassignInput).toEqual({
    subjectId: alphaRow!.subjectId,
    assignmentId: alphaRow!.id,
    revision: alphaRow!.revision,
  });
  expect(JSON.parse(response('owner.assignment.unassign.alpha').bodyText)).toEqual({ deleted: true });
  const assignmentUndoRevision = Number(
    response('owner.assignment.unassign.alpha').responseHeaders['library-label-assignment-revision'],
  );
  expect(Number.isInteger(assignmentUndoRevision)).toBe(true);
  const restoreAssignmentCommand = command('owner.assignment.restore.alpha');
  expect(restoreAssignmentCommand.path).toBe(`/v1/libraryLabels/${createAlpha.id}:restoreAssignment`);
  expect(JSON.parse(restoreAssignmentCommand.requestBodyText!)).toEqual({
    subjectId: alphaRow!.subjectId,
    assignmentId: alphaRow!.id,
    revision: assignmentUndoRevision,
  });
  expect(restoreAssignmentCommand.idempotencyKey).toBeTruthy();
  expect(restoreAssignmentCommand.idempotencyKey).not.toBe(command('owner.assignment.unassign.alpha').idempotencyKey);
  expect(json<{ assignment: { id: string } }>('owner.assignment.restore.alpha').assignment.id).toBe(alphaRow!.id);
  expect(rowForLabel('owner.assignments.after-assignment-restore', createAlpha.id)?.id).toBe(alphaRow!.id);

  const writes = fixture.manifest.filter(({ method }) => method !== 'GET');
  for (const write of writes) expect(command(write.scenario).idempotencyKey).toBeTruthy();
  for (const scenario of [
    'owner.assignment.clear.alpha',
    'owner.assignment.clear.beta',
    'owner.assignment.clear.long',
    'owner.label.delete.alpha-after-clear',
    'owner.label.delete.beta-after-clear',
    'owner.label.delete.long-after-clear',
  ] as const) {
    expect(response(scenario).status).toBe(200);
    expect(JSON.parse(response(scenario).bodyText)).toEqual({ deleted: true });
  }
});

test('captures actual foreign, anonymous and suspended responses without private Label names', () => {
  const privateNames = Object.values(fixture.seed.names);
  const foreignScenarios = [
    'bob.catalogue.prefix',
    'bob.assignments.subject',
    'anonymous.catalogue.prefix',
    'anonymous.assignments.subject',
    'suspended.catalogue.prefix',
    'suspended.assignments.subject',
  ] as const;
  for (const scenario of foreignScenarios) {
    const captured = response(scenario);
    expect(captured.persona).toBe(
      scenario.startsWith('bob.') ? 'bob' : scenario.startsWith('anonymous.') ? 'anonymous' : 'suspended',
    );
    expect(privateNames.every((name) => !captured.bodyText.includes(name))).toBe(true);
  }

  expect(response('bob.catalogue.prefix').status).toBe(200);
  expect(json<{ labels: unknown[]; next: string | null }>('bob.catalogue.prefix')).toEqual({ labels: [], next: null });
  expect(response('bob.assignments.subject').status).toBe(200);
  expect(json<{ assignments: unknown[]; next: string | null }>('bob.assignments.subject')).toEqual({
    assignments: [],
    next: null,
  });
  expect(response('anonymous.catalogue.prefix').status).toBe(401);
  expect(response('anonymous.assignments.subject').status).toBe(401);
  expect(response('suspended.catalogue.prefix').status).toBe(401);
  expect(response('suspended.assignments.subject').status).toBe(401);
});

test('clearing Label facts returns actual empty results and preserves state, progress and holding facts', () => {
  expect(json<{ assignments: unknown[]; next: string | null }>('owner.assignments.empty-after-clear')).toEqual({
    assignments: [],
    next: null,
  });
  expect(json<{ labels: unknown[]; next: string | null }>('owner.catalogue.empty-after-clear')).toEqual({
    labels: [],
    next: null,
  });

  const createdEntry = JSON.parse(fixture.supportingResponses.independentFacts.entryCreated.bodyText) as {
    libraryEntry: { state: unknown; revision: number };
  };
  const afterEntry = JSON.parse(fixture.supportingResponses.independentFacts.entryAfterLabelClear.bodyText) as {
    libraryEntry: { state: unknown; revision: number };
  };
  expect(fixture.supportingResponses.independentFacts.entryCreated.status).toBe(201);
  expect(fixture.supportingResponses.independentFacts.entryAfterLabelClear.status).toBe(200);
  expect(afterEntry.libraryEntry.state).toEqual(createdEntry.libraryEntry.state);
  expect(afterEntry.libraryEntry.revision).toBe(createdEntry.libraryEntry.revision);

  const createdSession = JSON.parse(fixture.supportingResponses.independentFacts.sessionCreated.bodyText) as {
    progressSession: { id: string; state: string; revision: number };
  };
  const afterSessions = JSON.parse(fixture.supportingResponses.independentFacts.sessionsAfterLabelClear.bodyText) as {
    progressSessions: { id: string; state: string; revision: number }[];
    next: string | null;
  };
  expect(fixture.supportingResponses.independentFacts.sessionCreated.status).toBe(201);
  expect(fixture.supportingResponses.independentFacts.sessionsAfterLabelClear.status).toBe(200);
  expect(afterSessions.progressSessions.find(({ id }) => id === createdSession.progressSession.id)).toMatchObject(
    createdSession.progressSession,
  );

  const createdHolding = JSON.parse(fixture.supportingResponses.independentFacts.holdingCreated.bodyText) as {
    copy: { id: string; status: unknown; revision: number };
  };
  const afterHoldings = JSON.parse(fixture.supportingResponses.independentFacts.holdingsAfterLabelClear.bodyText) as {
    copies: { id: string; status: unknown; revision: number }[];
    next: string | null;
  };
  expect(fixture.supportingResponses.independentFacts.holdingCreated.status).toBe(201);
  expect(fixture.supportingResponses.independentFacts.holdingsAfterLabelClear.status).toBe(200);
  expect(afterHoldings.copies.find(({ id }) => id === createdHolding.copy.id)).toMatchObject(createdHolding.copy);
});
