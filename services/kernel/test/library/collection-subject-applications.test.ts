import { expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { createReleasedDiscoveryFixture, discoveryKey } from '../support/released-discovery.ts';

const status = (response: HttpResponse, expected: number) => {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response;
};

test('Subject applications select exact occurrences and follow their order, removal and undo', async () => {
  const native = await createReleasedDiscoveryFixture({ version: 1 });
  try {
    const work = await native.createSubject('schema:Book', 'Work on the shelf');
    const applied = await native.createSubject('schema:Person', 'Person related to a selected occurrence');
    const request = native.request;
    const shelf = status(
      await request('alice', 'POST', '/v1/collections', { title: 'Shelf', visibility: 'private' }, discoveryKey()),
      201,
    ).body.collection as { id: string };
    const path = `/v1/collections/${shelf.id}`;
    const members = `${path}/members`;
    const add = async () =>
      status(await request('alice', 'POST', members, { subjectId: work.id }, discoveryKey()), 201).body.member as {
        id: string;
      };
    const first = await add();
    const second = await add();
    const third = await add();
    const applications = (id: string) => `${members}/${id}/applications`;
    const target = (id: string) => `${applications(id)}/${applied.id}`;
    const filter = `${path}/applications/${applied.id}/members`;
    const listed = async () => {
      const body = status(await request('alice', 'GET', filter), 200).body;
      return (body.members as { id: string }[]).map(({ id }) => id);
    };

    const key = discoveryKey();
    const receipt = { appliedSubjectId: applied.id, present: true };
    expect(status(await request('alice', 'PUT', target(second.id), undefined, key), 200).body).toEqual(receipt);
    expect(status(await request('alice', 'PUT', target(second.id), undefined, key), 200).body).toEqual(receipt);
    expect(status(await request('alice', 'GET', applications(first.id)), 200).body).toEqual({ appliedSubjectIds: [] });
    expect(status(await request('alice', 'GET', applications(second.id)), 200).body).toEqual({
      appliedSubjectIds: [applied.id],
    });
    status(await request('bob', 'GET', filter), 404);
    status(await request('bob', 'PUT', target(first.id), undefined, discoveryKey()), 404);

    status(await request('alice', 'PUT', target(third.id), undefined, discoveryKey()), 200);
    const initial = status(await request('alice', 'GET', `${filter}?limit=1`), 200).body;
    expect(initial.members).toEqual([expect.objectContaining({ id: second.id })]);
    expect(initial.next).toBeString();
    status(await request('alice', 'POST', `${members}/${third.id}:move`, { after: null }, discoveryKey()), 200);
    status(await request('alice', 'GET', `${filter}?cursor=${encodeURIComponent(initial.next as string)}`), 409);
    expect(await listed()).toEqual([third.id, second.id]);

    const current = status(await request('alice', 'GET', path), 200).body.collection as { revision: number };
    const deletion = status(
      await request(
        'alice',
        'DELETE',
        `${members}/${second.id}?revision=${current.revision}`,
        undefined,
        discoveryKey(),
      ),
      204,
    );
    status(await request('alice', 'GET', applications(second.id)), 404);
    expect(await listed()).toEqual([third.id]);

    const deletionId = deletion.headers.get('Library-Collection-Member-Deletion-Id');
    const revision = Number(deletion.headers.get('Library-Collection-Member-Deletion-Revision'));
    status(
      await request('alice', 'POST', `${members}/${second.id}:restore`, { deletionId, revision }, discoveryKey()),
      200,
    );
    expect(await listed()).toEqual([third.id, second.id]);
    expect(status(await request('alice', 'DELETE', target(third.id), undefined, discoveryKey()), 200).body).toEqual({
      appliedSubjectId: applied.id,
      present: false,
    });
    expect(await listed()).toEqual([second.id]);
  } finally {
    await native.close();
  }
}, 180_000);
