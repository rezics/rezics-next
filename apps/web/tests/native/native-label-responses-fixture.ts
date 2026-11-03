import { resolve } from 'node:path';
import { createLibraryLabelsSubject } from './library-labels-fixture.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export const NATIVE_LABEL_RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'retry-after',
  'www-authenticate',
  'library-label-revision',
  'library-label-assignment-revision',
] as const;

export type NativeLabelResponseHeader = (typeof NATIVE_LABEL_RESPONSE_HEADERS)[number];
export type NativeLabelPersona = 'alice' | 'bob' | 'anonymous' | 'suspended' | 'governor' | 'editor';
export type NativeLabelMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Exact route/state/persona map consumed by the existing Labels and Subject controls reviewer. */
export const NATIVE_LABEL_RESPONSE_MANIFEST = [
  { scenario: 'owner.label.create.alpha', routeState: 'create one of several independent labels', method: 'POST', route: '/v1/libraryLabels', persona: 'alice' },
  { scenario: 'owner.label.create.beta', routeState: 'create a label that is renamed and deleted/restored', method: 'POST', route: '/v1/libraryLabels', persona: 'alice' },
  { scenario: 'owner.label.create.long', routeState: 'create a legal 100-scalar name', method: 'POST', route: '/v1/libraryLabels', persona: 'alice' },
  { scenario: 'owner.label.rename.beta', routeState: 'rename an existing label using its observed revision', method: 'PATCH', route: '/v1/libraryLabels/{id}', persona: 'alice' },
  { scenario: 'owner.catalogue.prefix.first', routeState: 'literal prefix catalogue page with a continuation', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=2', persona: 'alice' },
  { scenario: 'owner.catalogue.prefix.final', routeState: 'literal prefix catalogue final page from its returned cursor', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&cursor={returnedCursor}&limit=2', persona: 'alice' },
  { scenario: 'owner.catalogue.empty-prefix', routeState: 'owner prefix with an actual empty result', method: 'GET', route: '/v1/libraryLabels?q={unmatchedPrefix}&limit=2', persona: 'alice' },
  { scenario: 'owner.catalogue.before-clear', routeState: 'renamed catalogue before label facts clear', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=32', persona: 'alice' },
  { scenario: 'owner.catalogue.after-parent-delete', routeState: 'catalogue while one parent label is deleted', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=32', persona: 'alice' },
  { scenario: 'owner.catalogue.after-parent-restore', routeState: 'catalogue after ordinary exact parent restore', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=32', persona: 'alice' },
  { scenario: 'owner.assignment.assign.alpha', routeState: 'assign first independent label', method: 'POST', route: '/v1/libraryLabels/{id}:assign', persona: 'alice' },
  { scenario: 'owner.assignment.assign.beta', routeState: 'assign second independent label', method: 'POST', route: '/v1/libraryLabels/{id}:assign', persona: 'alice' },
  { scenario: 'owner.assignment.assign.long', routeState: 'assign long-name label', method: 'POST', route: '/v1/libraryLabels/{id}:assign', persona: 'alice' },
  { scenario: 'owner.assignments.subject.first', routeState: 'FULL subject assignment page with a continuation', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=2', persona: 'alice' },
  { scenario: 'owner.assignments.subject.final', routeState: 'FULL subject assignment final page from its returned cursor', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&cursor={returnedCursor}&limit=2', persona: 'alice' },
  { scenario: 'owner.label.delete-parent', routeState: 'delete an assigned parent label and retain its actual undo revision', method: 'DELETE', route: '/v1/libraryLabels/{id}?revision={observedRevision}', persona: 'alice' },
  { scenario: 'owner.assignments.after-parent-delete', routeState: 'effective subject assignments while parent is deleted', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'alice' },
  { scenario: 'owner.label.restore-parent', routeState: 'ordinary exact parent restore using the delete response header', method: 'POST', route: '/v1/libraryLabels/{id}:restore', persona: 'alice' },
  { scenario: 'owner.assignments.after-parent-restore', routeState: 'effective assignments after ordinary parent restore', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'alice' },
  { scenario: 'owner.assignment.unassign.alpha', routeState: 'unassign from an observed FULL membership row', method: 'POST', route: '/v1/libraryLabels/{id}:unassign', persona: 'alice' },
  { scenario: 'owner.assignment.restore.alpha', routeState: 'ordinary exact assignment restore using the unassign response header', method: 'POST', route: '/v1/libraryLabels/{id}:restoreAssignment', persona: 'alice' },
  { scenario: 'owner.assignments.after-assignment-restore', routeState: 'effective assignments after ordinary exact assignment restore', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'alice' },
  { scenario: 'owner.assignments.before-clear', routeState: 'actual assignment rows used to clear label facts', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'alice' },
  { scenario: 'bob.catalogue.prefix', routeState: 'another owner catalogue disclosure', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=20', persona: 'bob' },
  { scenario: 'bob.assignments.subject', routeState: 'another owner subject assignment disclosure', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'bob' },
  { scenario: 'anonymous.catalogue.prefix', routeState: 'anonymous catalogue disclosure', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=20', persona: 'anonymous' },
  { scenario: 'anonymous.assignments.subject', routeState: 'anonymous subject assignment disclosure', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'anonymous' },
  { scenario: 'suspended.catalogue.prefix', routeState: 'genuine suspended account catalogue response', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=20', persona: 'suspended' },
  { scenario: 'suspended.assignments.subject', routeState: 'genuine suspended account assignment response', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'suspended' },
  { scenario: 'owner.assignment.clear.alpha', routeState: 'clear first assignment fact', method: 'POST', route: '/v1/libraryLabels/{id}:unassign', persona: 'alice' },
  { scenario: 'owner.assignment.clear.beta', routeState: 'clear second assignment fact', method: 'POST', route: '/v1/libraryLabels/{id}:unassign', persona: 'alice' },
  { scenario: 'owner.assignment.clear.long', routeState: 'clear long-name assignment fact', method: 'POST', route: '/v1/libraryLabels/{id}:unassign', persona: 'alice' },
  { scenario: 'owner.assignments.empty-after-clear', routeState: 'actual empty subject assignment result after clearing labels', method: 'GET', route: '/v1/libraryLabelAssignments?subjectId={subjectId}&view=FULL&limit=32', persona: 'alice' },
  { scenario: 'owner.label.delete.alpha-after-clear', routeState: 'delete first label after its assignment is cleared', method: 'DELETE', route: '/v1/libraryLabels/{id}?revision={observedRevision}', persona: 'alice' },
  { scenario: 'owner.label.delete.beta-after-clear', routeState: 'delete second label after its assignment is cleared', method: 'DELETE', route: '/v1/libraryLabels/{id}?revision={observedRevision}', persona: 'alice' },
  { scenario: 'owner.label.delete.long-after-clear', routeState: 'delete long-name label after its assignment is cleared', method: 'DELETE', route: '/v1/libraryLabels/{id}?revision={observedRevision}', persona: 'alice' },
  { scenario: 'owner.catalogue.empty-after-clear', routeState: 'actual empty owner catalogue result after clearing labels', method: 'GET', route: '/v1/libraryLabels?q={literalPrefix}&limit=2', persona: 'alice' },
] as const;

export type NativeLabelResponseScenario = (typeof NATIVE_LABEL_RESPONSE_MANIFEST)[number]['scenario'];

export type NativeLabelSourceBuildIdentity = {
  source: { revision: string | null; clean: boolean | null };
  build: { runtime: 'Bun'; runtimeVersion: string; kernelOrigin: string; webOrigin: string };
  currentDevRecording: boolean;
};

export type NativeLabelCommand = {
  sequence: number;
  step: string;
  method: NativeLabelMethod;
  path: string;
  persona: NativeLabelPersona;
  contentType?: string;
  requestBodyText?: string;
  idempotencyKey?: string;
};

export type NativeLabelResponseRecord = {
  availability: 'available';
  scenario: NativeLabelResponseScenario;
  routeState: string;
  method: NativeLabelMethod;
  path: string;
  persona: NativeLabelPersona;
  status: number;
  bodyText: string;
  responseHeaders: Partial<Record<NativeLabelResponseHeader, string>>;
  sourceBuild: NativeLabelSourceBuildIdentity;
  commandSequence: number;
};

export type NativeLabelSupportingResponse = {
  step: string;
  method: NativeLabelMethod;
  path: string;
  persona: NativeLabelPersona;
  status: number;
  bodyText: string;
  responseHeaders: Partial<Record<NativeLabelResponseHeader, string>>;
  sourceBuild: NativeLabelSourceBuildIdentity;
  commandSequence: number;
};

export type NativeLabelResponsesFixture = {
  manifest: typeof NATIVE_LABEL_RESPONSE_MANIFEST;
  sourceBuild: NativeLabelSourceBuildIdentity;
  seed: {
    subjectProducer: 'createLibraryLabelsSubject';
    subjectId: string;
    subjectTitle: string;
    prefix: string;
    names: { alpha: string; beta: string; renamedBeta: string; long: string };
  };
  auth: { signedInPersonas: readonly ['alice', 'bob']; suspendedPersona: 'suspended' };
  commandSequence: readonly NativeLabelCommand[];
  responses: Readonly<Record<NativeLabelResponseScenario, NativeLabelResponseRecord>>;
  supportingResponses: {
    exposurePersonalLibrary: NativeLabelSupportingResponse;
    exposureReadingProgress: NativeLabelSupportingResponse;
    activeDefinitions: NativeLabelSupportingResponse;
    releasedDefinitions: NativeLabelSupportingResponse;
    independentFacts: {
      entryCreated: NativeLabelSupportingResponse;
      sessionCreated: NativeLabelSupportingResponse;
      holdingCreated: NativeLabelSupportingResponse;
      entryAfterLabelClear: NativeLabelSupportingResponse;
      sessionsAfterLabelClear: NativeLabelSupportingResponse;
      holdingsAfterLabelClear: NativeLabelSupportingResponse;
    };
  };
  close(): Promise<void>;
};

type RawResponse = Omit<NativeLabelSupportingResponse, 'step'> & { step: string };
type CapturedRequest = { command: NativeLabelCommand; response: RawResponse };

const repositoryRoot = resolve(import.meta.dir, '../../../..');

function gitText(args: string[]): string | null {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

function sourceBuildIdentity(stack: NativeWebStack): NativeLabelSourceBuildIdentity {
  const revision = gitText(['rev-parse', 'HEAD']);
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=all']);
  const clean = status === null ? null : status.length === 0;
  return {
    source: { revision, clean },
    build: {
      runtime: 'Bun',
      runtimeVersion: Bun.version,
      kernelOrigin: stack.kernelOrigin,
      webOrigin: new URL(stack.web).origin,
    },
    currentDevRecording: revision !== null && clean === true,
  };
}

function responseHeaders(response: Response): Partial<Record<NativeLabelResponseHeader, string>> {
  const captured: Partial<Record<NativeLabelResponseHeader, string>> = {};
  for (const name of NATIVE_LABEL_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return captured;
}

function commandKey(): string {
  return `"${crypto.randomUUID()}"`;
}

function requestInit(method: NativeLabelMethod, body?: unknown, key?: string): RequestInit {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (key !== undefined) headers.set('idempotency-key', key);
  return {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function expectStatus(response: { status: number; bodyText: string }, expected: number, step: string): void {
  if (response.status !== expected)
    throw new Error(`${step} returned ${response.status}, expected ${expected}: ${response.bodyText}`);
}

function responseValue<T>(response: { bodyText: string; status: number }, expected: number, step: string): T {
  expectStatus(response, expected, step);
  return JSON.parse(response.bodyText) as T;
}

function nextCursor(bodyText: string, step: string): string {
  const body = JSON.parse(bodyText) as { next?: unknown };
  if (typeof body.next !== 'string' || body.next.length === 0)
    throw new Error(`${step} did not emit a continuation cursor: ${bodyText}`);
  return body.next;
}

function requiredHeader(response: { responseHeaders: Partial<Record<NativeLabelResponseHeader, string>> }, name: NativeLabelResponseHeader, step: string): string {
  const value = response.responseHeaders[name];
  if (value === undefined) throw new Error(`${step} omitted its actual ${name} response header`);
  return value;
}

function literalPrefixPath(prefix: string, limit: number): string {
  return `/v1/libraryLabels?q=${encodeURIComponent(prefix)}&limit=${limit}`;
}

function literalPrefixCursorPath(prefix: string, cursor: string, limit: number): string {
  return `/v1/libraryLabels?q=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(cursor)}&limit=${limit}`;
}

function subjectAssignmentsPath(subjectId: string, limit: number, cursor?: string): string {
  const query = new URLSearchParams({ subjectId, view: 'FULL' });
  if (cursor !== undefined) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return `/v1/libraryLabelAssignments?${query.toString()}`;
}

/**
 * Runs the installed native producer and exports its exact HTTP responses for the existing Labels/Subject reviewer.
 * The fixture captures route bytes and allowlisted headers only; it does not make page stories or simulated recordings.
 */
export async function createNativeLabelResponsesFixture(): Promise<NativeLabelResponsesFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  let closed: Promise<void> | undefined;
  try {
    const sourceBuild = sourceBuildIdentity(stack);
    const commandSequence: NativeLabelCommand[] = [];
    let commandNumber = 0;

    const execute = async (
      step: string,
      path: string,
      persona: NativeLabelPersona,
      init: RequestInit = {},
    ): Promise<CapturedRequest> => {
      const headers = new Headers(init.headers);
      const command: NativeLabelCommand = {
        sequence: commandNumber++,
        step,
        method: (init.method ?? 'GET') as NativeLabelMethod,
        path,
        persona,
        ...(headers.get('content-type') === null ? {} : { contentType: headers.get('content-type')! }),
        ...(typeof init.body === 'string' ? { requestBodyText: init.body } : {}),
        ...(headers.get('idempotency-key') === null ? {} : { idempotencyKey: headers.get('idempotency-key')! }),
      };
      commandSequence.push(command);
      const actual = await stack.kernel(path, init, persona);
      const bodyText = await actual.text();
      const response: RawResponse = {
        step,
        method: command.method,
        path,
        persona,
        status: actual.status,
        bodyText,
        responseHeaders: responseHeaders(actual),
        sourceBuild,
        commandSequence: command.sequence,
      };
      return { command, response };
    };

    const supporting = async (
      step: string,
      path: string,
      persona: NativeLabelPersona,
      init: RequestInit = {},
    ): Promise<NativeLabelSupportingResponse> => (await execute(step, path, persona, init)).response;

    const responses = {} as Record<NativeLabelResponseScenario, NativeLabelResponseRecord>;
    const captureLabel = async (
      scenario: NativeLabelResponseScenario,
      path: string,
      persona: NativeLabelPersona,
      init: RequestInit = {},
    ): Promise<NativeLabelResponseRecord> => {
      const descriptor = NATIVE_LABEL_RESPONSE_MANIFEST.find((item) => item.scenario === scenario);
      if (!descriptor) throw new Error(`Scenario ${scenario} is absent from the closed Label manifest`);
      const { command, response } = await execute(scenario, path, persona, init);
      const record: NativeLabelResponseRecord = {
        availability: 'available',
        scenario,
        routeState: descriptor.routeState,
        method: command.method,
        path,
        persona,
        status: response.status,
        bodyText: response.bodyText,
        responseHeaders: response.responseHeaders,
        sourceBuild,
        commandSequence: command.sequence,
      };
      responses[scenario] = record;
      return record;
    };

    const exposurePersonalLibrary = await supporting(
      'setup.exposure.personal-library',
      '/v1/platform/exposure/personal_library:open',
      'governor',
      requestInit('POST', undefined, commandKey()),
    );
    expectStatus(exposurePersonalLibrary, 200, 'Open personal_library exposure');
    const exposureReadingProgress = await supporting(
      'setup.exposure.reading-progress',
      '/v1/platform/exposure/reading_progress:open',
      'governor',
      requestInit('POST', undefined, commandKey()),
    );
    expectStatus(exposureReadingProgress, 200, 'Open reading_progress exposure');

    const subject = await createLibraryLabelsSubject(stack);
    auth = await startAuthStack(stack);
    await auth.signIn('alice');
    await auth.signIn('bob');

    const activeDefinitions = await supporting('setup.definitions.active', '/v1/definitions/active', 'alice');
    const active = responseValue<{ digest: string }>(activeDefinitions, 200, 'Read active Definitions release');
    const releasedDefinitions = await supporting(
      'setup.definitions.release',
      `/v1/definitions/releases/${encodeURIComponent(active.digest)}`,
      'alice',
    );
    const releaseResult = responseValue<{
      release: {
        types: Record<string, { library?: { profileId?: string } }>;
        libraryProfiles: Record<
          string,
          {
            entryStateSet?: { states: { id: string; role: string }[] };
            progress?: { allowed: { mode: string; units: { id: string }[] }[] };
          }
        >;
      };
    }>(releasedDefinitions, 200, 'Read active Definitions release body');
    const profileId = releaseResult.release.types['schema:Book']?.library?.profileId;
    if (!profileId) throw new Error('The active Book type did not emit a Library profile ID');
    const profile = releaseResult.release.libraryProfiles[profileId];
    const activeState = profile?.entryStateSet?.states.find((state) => state.role === 'active');
    if (!activeState) throw new Error('The active Book profile did not emit an active entry state');
    const scalarProgress = profile?.progress?.allowed.find((mode) => mode.mode === 'scalar_amount');
    const progressUnit = scalarProgress?.units[0]?.id;
    if (!progressUnit) throw new Error('The active Book profile did not emit a scalar progress unit');

    const entryCreated = await supporting(
      'facts.entry.created',
      `/v1/libraryEntries/${encodeURIComponent(subject.id)}`,
      'alice',
      requestInit('PUT', { state: activeState.id }, commandKey()),
    );
    responseValue(entryCreated, 201, 'Create independent Library state');
    const sessionCreated = await supporting(
      'facts.progress-session.created',
      '/v1/progressSessions',
      'alice',
      requestInit(
        'POST',
        { subjectId: subject.id, mode: 'scalar_amount', unit: progressUnit, total: null },
        commandKey(),
      ),
    );
    responseValue(sessionCreated, 201, 'Create independent progress session');
    const holdingCreated = await supporting(
      'facts.holding.created',
      '/v1/copies',
      'alice',
      requestInit(
        'POST',
        {
          subjectId: subject.id,
          kind: 'physical',
          status: 'owned',
          location: null,
          source: null,
          acquiredOn: null,
          disposedOn: null,
          note: null,
        },
        commandKey(),
      ),
    );
    responseValue(holdingCreated, 201, 'Create independent holding');

    const prefix = `Native labels ${crypto.randomUUID().slice(0, 8)} %_`;
    const alphaName = `${prefix} Alpha`;
    const betaName = `${prefix} Beta`;
    const renamedBetaName = `${prefix} Beta renamed`;
    const longName = `${prefix} ${'長'.repeat(100 - Array.from(`${prefix} `).length)}`;
    if (Array.from(longName).length !== 100) throw new Error('Native Label long-name fixture is not 100 Unicode scalars');
    const seed = {
      subjectProducer: 'createLibraryLabelsSubject' as const,
      subjectId: subject.id,
      subjectTitle: subject.title,
      prefix,
      names: { alpha: alphaName, beta: betaName, renamedBeta: renamedBetaName, long: longName },
    };

    const createLabel = (scenario: NativeLabelResponseScenario, name: string) =>
      captureLabel(scenario, '/v1/libraryLabels', 'alice', requestInit('POST', { name }, commandKey()));
    const createdAlpha = await createLabel('owner.label.create.alpha', alphaName);
    const createdBeta = await createLabel('owner.label.create.beta', betaName);
    const createdLong = await createLabel('owner.label.create.long', longName);
    const alpha = responseValue<{ label: { id: string; revision: number } }>(createdAlpha, 201, 'Create alpha label').label;
    const beta = responseValue<{ label: { id: string; revision: number } }>(createdBeta, 201, 'Create beta label').label;
    const long = responseValue<{ label: { id: string; revision: number } }>(createdLong, 201, 'Create long label').label;

    const renameBeta = await captureLabel(
      'owner.label.rename.beta',
      `/v1/libraryLabels/${encodeURIComponent(beta.id)}`,
      'alice',
      requestInit('PATCH', { name: renamedBetaName, revision: beta.revision }, commandKey()),
    );
    const renamed = responseValue<{ label: { id: string; revision: number } }>(renameBeta, 200, 'Rename beta label').label;

    const prefixFirst = await captureLabel(
      'owner.catalogue.prefix.first',
      literalPrefixPath(prefix, 2),
      'alice',
    );
    const cursor = nextCursor(prefixFirst.bodyText, 'Owner catalogue first page');
    await captureLabel(
      'owner.catalogue.prefix.final',
      literalPrefixCursorPath(prefix, cursor, 2),
      'alice',
    );
    await captureLabel(
      'owner.catalogue.empty-prefix',
      literalPrefixPath(`${prefix} no-match`, 2),
      'alice',
    );

    const assign = async (scenario: NativeLabelResponseScenario, labelId: string) =>
      captureLabel(
        scenario,
        `/v1/libraryLabels/${encodeURIComponent(labelId)}:assign`,
        'alice',
        requestInit('POST', { subjectId: subject.id }, commandKey()),
      );
    const assignedAlpha = await assign('owner.assignment.assign.alpha', alpha.id);
    const assignedBeta = await assign('owner.assignment.assign.beta', renamed.id);
    const assignedLong = await assign('owner.assignment.assign.long', long.id);
    responseValue(assignedAlpha, 200, 'Assign alpha label');
    responseValue(assignedBeta, 200, 'Assign renamed beta label');
    responseValue(assignedLong, 200, 'Assign long label');

    const assignmentFirst = await captureLabel(
      'owner.assignments.subject.first',
      subjectAssignmentsPath(subject.id, 2),
      'alice',
    );
    const assignmentCursor = nextCursor(assignmentFirst.bodyText, 'Owner subject assignments first page');
    await captureLabel(
      'owner.assignments.subject.final',
      subjectAssignmentsPath(subject.id, 2, assignmentCursor),
      'alice',
    );

    const deleteParent = await captureLabel(
      'owner.label.delete-parent',
      `/v1/libraryLabels/${encodeURIComponent(renamed.id)}?revision=${encodeURIComponent(String(renamed.revision))}`,
      'alice',
      requestInit('DELETE', undefined, commandKey()),
    );
    responseValue(deleteParent, 200, 'Delete assigned parent label');
    await captureLabel(
      'owner.assignments.after-parent-delete',
      subjectAssignmentsPath(subject.id, 32),
      'alice',
    );
    await captureLabel(
      'owner.catalogue.after-parent-delete',
      literalPrefixPath(prefix, 32),
      'alice',
    );
    const deletedLabelRevision = Number(requiredHeader(deleteParent, 'library-label-revision', 'Delete parent label'));
    const restoreParent = await captureLabel(
      'owner.label.restore-parent',
      `/v1/libraryLabels/${encodeURIComponent(renamed.id)}:restore`,
      'alice',
      requestInit('POST', { revision: deletedLabelRevision }, commandKey()),
    );
    const restoredBeta = responseValue<{ label: { id: string; revision: number } }>(
      restoreParent,
      200,
      'Restore deleted parent label',
    ).label;
    const afterParentRestore = await captureLabel(
      'owner.assignments.after-parent-restore',
      subjectAssignmentsPath(subject.id, 32),
      'alice',
    );
    await captureLabel(
      'owner.catalogue.after-parent-restore',
      literalPrefixPath(prefix, 32),
      'alice',
    );

    const assignmentRows = (response: NativeLabelResponseRecord) =>
      (JSON.parse(response.bodyText) as { assignments: { id: string; labelId: string; subjectId: string; revision: number }[] }).assignments;
    const alphaAssignment = assignmentRows(afterParentRestore).find((assignment) => assignment.labelId === alpha.id);
    if (!alphaAssignment) throw new Error('The actual FULL assignment response omitted the alpha label membership');
    const unassignAlpha = await captureLabel(
      'owner.assignment.unassign.alpha',
      `/v1/libraryLabels/${encodeURIComponent(alpha.id)}:unassign`,
      'alice',
      requestInit(
        'POST',
        {
          subjectId: alphaAssignment.subjectId,
          assignmentId: alphaAssignment.id,
          revision: alphaAssignment.revision,
        },
        commandKey(),
      ),
    );
    responseValue(unassignAlpha, 200, 'Unassign alpha label');
    const assignmentDeleteRevision = Number(
      requiredHeader(unassignAlpha, 'library-label-assignment-revision', 'Unassign alpha label'),
    );
    const restoreAssignment = await captureLabel(
      'owner.assignment.restore.alpha',
      `/v1/libraryLabels/${encodeURIComponent(alpha.id)}:restoreAssignment`,
      'alice',
      requestInit(
        'POST',
        {
          subjectId: alphaAssignment.subjectId,
          assignmentId: alphaAssignment.id,
          revision: assignmentDeleteRevision,
        },
        commandKey(),
      ),
    );
    responseValue(restoreAssignment, 200, 'Restore alpha assignment');
    await captureLabel(
      'owner.assignments.after-assignment-restore',
      subjectAssignmentsPath(subject.id, 32),
      'alice',
    );

    const privacyReads: [NativeLabelResponseScenario, string, NativeLabelPersona][] = [
      ['bob.catalogue.prefix', literalPrefixPath(prefix, 20), 'bob'],
      ['bob.assignments.subject', subjectAssignmentsPath(subject.id, 32), 'bob'],
      ['anonymous.catalogue.prefix', literalPrefixPath(prefix, 20), 'anonymous'],
      ['anonymous.assignments.subject', subjectAssignmentsPath(subject.id, 32), 'anonymous'],
      ['suspended.catalogue.prefix', literalPrefixPath(prefix, 20), 'suspended'],
      ['suspended.assignments.subject', subjectAssignmentsPath(subject.id, 32), 'suspended'],
    ];
    for (const [scenario, path, persona] of privacyReads) await captureLabel(scenario, path, persona);

    const beforeClear = await captureLabel(
      'owner.catalogue.before-clear',
      literalPrefixPath(prefix, 32),
      'alice',
    );
    const currentLabels = (JSON.parse(beforeClear.bodyText) as {
      labels: { id: string; name: string; revision: number }[];
    }).labels;
    const afterUndo = await captureLabel(
      'owner.assignments.before-clear',
      subjectAssignmentsPath(subject.id, 32),
      'alice',
    );
    const currentAssignments = assignmentRows(afterUndo);
    const clearingLabels = [
      { id: alpha.id, scenario: 'owner.assignment.clear.alpha' as const },
      { id: restoredBeta.id, scenario: 'owner.assignment.clear.beta' as const },
      { id: long.id, scenario: 'owner.assignment.clear.long' as const },
    ];
    for (const label of clearingLabels) {
      const assignment = currentAssignments.find((row) => row.labelId === label.id);
      if (!assignment) throw new Error(`The actual FULL assignment response omitted label ${label.id} before clearing`);
      await captureLabel(
        label.scenario,
        `/v1/libraryLabels/${encodeURIComponent(label.id)}:unassign`,
        'alice',
        requestInit(
          'POST',
          { subjectId: assignment.subjectId, assignmentId: assignment.id, revision: assignment.revision },
          commandKey(),
        ),
      );
    }
    const assignmentsEmpty = await captureLabel(
      'owner.assignments.empty-after-clear',
      subjectAssignmentsPath(subject.id, 32),
      'alice',
    );

    const labelsById = new Map(currentLabels.map((label) => [label.id, label]));
    const deleteScenarios = [
      { id: alpha.id, scenario: 'owner.label.delete.alpha-after-clear' as const },
      { id: restoredBeta.id, scenario: 'owner.label.delete.beta-after-clear' as const },
      { id: long.id, scenario: 'owner.label.delete.long-after-clear' as const },
    ];
    for (const item of deleteScenarios) {
      const label = labelsById.get(item.id);
      if (!label) throw new Error(`The actual owner catalogue response omitted label ${item.id} before deletion`);
      await captureLabel(
        item.scenario,
        `/v1/libraryLabels/${encodeURIComponent(label.id)}?revision=${encodeURIComponent(String(label.revision))}`,
        'alice',
        requestInit('DELETE', undefined, commandKey()),
      );
    }
    const catalogueEmpty = await captureLabel(
      'owner.catalogue.empty-after-clear',
      literalPrefixPath(prefix, 2),
      'alice',
    );

    const entryAfterLabelClear = await supporting(
      'facts.entry.after-label-clear',
      `/v1/libraryEntries/${encodeURIComponent(subject.id)}?view=FULL`,
      'alice',
    );
    const sessionsAfterLabelClear = await supporting(
      'facts.progress-sessions.after-label-clear',
      `/v1/progressSessions?subjectId=${encodeURIComponent(subject.id)}&limit=100`,
      'alice',
    );
    const holdingsAfterLabelClear = await supporting(
      'facts.holdings.after-label-clear',
      `/v1/copies?subjectId=${encodeURIComponent(subject.id)}&limit=100&view=FULL`,
      'alice',
    );

    const missing = NATIVE_LABEL_RESPONSE_MANIFEST.filter((item) => responses[item.scenario] === undefined);
    if (missing.length > 0) throw new Error(`Native Label response manifest is incomplete: ${missing.map(({ scenario }) => scenario).join(', ')}`);
    if (assignmentsEmpty.status !== 200 || catalogueEmpty.status !== 200)
      throw new Error('Native Label empty outcomes were not returned by the installed API');

    const result: NativeLabelResponsesFixture = {
      manifest: NATIVE_LABEL_RESPONSE_MANIFEST,
      sourceBuild,
      seed,
      auth: { signedInPersonas: ['alice', 'bob'], suspendedPersona: 'suspended' },
      commandSequence,
      responses,
      supportingResponses: {
        exposurePersonalLibrary,
        exposureReadingProgress,
        activeDefinitions,
        releasedDefinitions,
        independentFacts: {
          entryCreated,
          sessionCreated,
          holdingCreated,
          entryAfterLabelClear,
          sessionsAfterLabelClear,
          holdingsAfterLabelClear,
        },
      },
      close() {
        return (closed ??= (async () => {
          try {
            await auth?.stop();
          } finally {
            await stack.stop();
          }
        })());
      },
    };
    return result;
  } catch (error) {
    try {
      await auth?.stop();
    } finally {
      await stack.stop();
    }
    throw error;
  }
}
