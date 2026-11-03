import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createNativeLibraryNavigationResponsesFixture,
  type NativeLibraryNavigationRawResponse,
  type NativeLibraryNavigationResponseFixture,
} from './native-library-navigation-responses-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

let stack: NativeWebStack | undefined;
let auth: NativeAuthStack | undefined;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

function responseFor(fixture: NativeLibraryNavigationResponseFixture, scenarioId: string): NativeLibraryNavigationRawResponse {
  const scenario = fixture.scenarios.find((item) => item.scenarioId === scenarioId);
  expect(scenario, `the closed scenario ${scenarioId} is exported`).toBeDefined();
  expect(scenario!.responseIds).toHaveLength(1);
  const response = fixture.responses.find((item) => item.id === scenario!.responseIds[0]);
  expect(response, `the ${scenarioId} response remains in the raw export`).toBeDefined();
  return response!;
}

function textOf(body: unknown): string {
  return JSON.stringify(body);
}

test('native Library and My Collections exports retain raw owner-local responses and emitted destinations', async () => {
  const fixture = await createNativeLibraryNavigationResponsesFixture(stack!, auth!);
  expect(fixture.binding).toBeDefined();
  expect(fixture.binding.sourceIdentity).toMatch(/^(known|unknown)$/u);
  if (fixture.binding.sourceIdentity === 'known') {
    expect(fixture.binding.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(fixture.binding.sourceTreeClean).toBeBoolean();
    expect(fixture.binding.currentDevRecording).toBe(fixture.binding.sourceTreeClean);
  } else {
    expect(fixture.binding.sourceCommit).toBeNull();
    expect(fixture.binding.sourceTreeClean).toBeNull();
    expect(fixture.binding.currentDevRecording).toBe(false);
  }
  expect(fixture.binding.runtime).toMatchObject({
    producer: 'startNativeWebStack + startAuthStack',
    mode: 'worktree-dev',
  });

  const expectedScenarioIds = fixture.manifest.map(({ id }) => id).sort();
  expect(fixture.scenarios.map(({ scenarioId }) => scenarioId).sort()).toEqual(expectedScenarioIds);
  for (const response of fixture.responses) {
    const command = fixture.commands.find(({ id }) => id === response.commandId);
    expect(command, `${response.id} retains its original command`).toBeDefined();
    expect(response).toMatchObject({
      method: command!.method,
      path: command!.path,
      persona: command!.persona,
    });
    if (response.headers['content-type']?.includes('application/json'))
      expect(response.body).toEqual(JSON.parse(response.bodyText));
  }

  const ownerCollections = responseFor(fixture, 'collections.alice.owner');
  const otherCollections = responseFor(fixture, 'collections.alice.viewer');
  expect(ownerCollections.status).toBe(200);
  expect(textOf(ownerCollections.body)).toContain(fixture.fixtureFacts.privateCollectionId);
  expect(textOf(otherCollections.body)).not.toContain(fixture.fixtureFacts.privateCollectionId);

  const ownerEntry = responseFor(fixture, 'entry.alice.owner');
  const otherEntry = responseFor(fixture, 'entry.alice.viewer');
  expect(ownerEntry.status).toBe(200);
  expect(otherEntry.status).toBe(404);
  expect(otherEntry.bodyText).not.toContain(fixture.fixtureFacts.aliceSubjectId);
  expect(otherEntry.bodyText).not.toContain('Native library member');

  const pinWrite = fixture.commands.find(
    (command) => command.method === 'PUT' && command.path === `/v1/libraryPins/${fixture.fixtureFacts.publicCollectionId}`,
  );
  expect(pinWrite, 'the existing fixture pins through its native command').toBeDefined();
  expect(pinWrite!.headers['idempotency-key']).toBeTruthy();
  const writeResponse = fixture.responses.find(({ commandId }) => commandId === pinWrite!.id);
  expect(writeResponse?.status).toBe(200);
  const priorPinList = fixture.responses
    .filter(({ method, path, persona, commandId }) => {
      const command = fixture.commands.find((item) => item.id === commandId);
      return method === 'GET' && path === '/v1/libraryPins?limit=100' && persona === 'bob' && command!.sequence < pinWrite!.sequence;
    })
    .at(-1);
  expect(priorPinList).toBeDefined();
  const inputRevision = JSON.parse(pinWrite!.bodyText ?? '{}').revision as number;
  expect(fixture.observedRevisions).toContainEqual({
    commandId: priorPinList!.commandId,
    responseId: priorPinList!.id,
    field: 'body.revision',
    value: inputRevision,
  });
  const currentBobPins = responseFor(fixture, 'pins.bob.owner');
  const currentAlicePins = responseFor(fixture, 'pins.alice.owner');
  expect(currentBobPins.status).toBe(200);
  expect(textOf(currentBobPins.body)).toContain(fixture.fixtureFacts.publicCollectionId);
  expect(textOf(currentAlicePins.body)).not.toContain(fixture.fixtureFacts.publicCollectionId);

  const bobCollections = responseFor(fixture, 'collections.bob.owner');
  const bobDescriptors = (bobCollections.body as { collections?: { id?: string; builtinKind?: string }[] }).collections ?? [];
  const everythingId = bobDescriptors.find(({ builtinKind }) => builtinKind === 'everything')?.id;
  const memberScenario = fixture.scenarios.find(({ scenarioId }) => scenarioId === 'members.everything.bob')!;
  if (everythingId && memberScenario.state !== 'dependency_unavailable') {
    const memberResponse = fixture.responses.find(({ id }) => id === memberScenario.responseIds[0])!;
    expect(memberResponse.path).toBe(`/v1/collections/${everythingId}/members?limit=20`);
    if (memberResponse.status === 202) {
      expect(memberResponse.body).toEqual({ preparing: true });
      expect(memberResponse.headers['cache-control']).toContain('private');
      expect(memberResponse.headers['cache-control']).toContain('no-store');
      expect(Number(memberResponse.headers['retry-after'])).toBeGreaterThan(0);
    } else if (memberResponse.status === 404) {
      expect(memberScenario.state).toBe('unavailable');
    } else {
      expect(memberResponse.status).toBe(200);
      expect(memberResponse.bodyText).toContain(fixture.fixtureFacts.bobSubjectId);
    }
  } else {
    expect(memberScenario.state).toBe('dependency_unavailable');
    expect(memberScenario.responseIds).toEqual([]);
  }

  const aliceMyCollections = fixture.scenarios.find(({ scenarioId }) => scenarioId === 'page.my-collections.alice')!;
  const bobMyCollections = fixture.scenarios.find(({ scenarioId }) => scenarioId === 'page.my-collections.bob')!;
  const aliceLinks = fixture.destinations.filter(({ id }) => aliceMyCollections.destinationIds.includes(id));
  const bobLinks = fixture.destinations.filter(({ id }) => bobMyCollections.destinationIds.includes(id));
  expect(aliceLinks.some(({ href }) => href === `/en/collections/${fixture.fixtureFacts.privateCollectionId}`)).toBe(true);
  expect(bobLinks.some(({ href }) => href === `/en/collections/${fixture.fixtureFacts.privateCollectionId}`)).toBe(false);
});
