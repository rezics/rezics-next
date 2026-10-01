// Seeds the records the G-704 browser journeys read into the isolated QA stack the e2e harness started, through
// Main's routes, and prints their IDs as JSON. The browser signs in as the stack's web member: a contributor on the
// Swedish Work, and a steward of the Pride and Prejudice wiki, whose reviewers and assistant are the API members
// the later steps drive through `g-704-act.ts`.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  type Command,
  loopStack,
  memberState,
  type Roles,
  short,
  wikiWorld,
} from '../../../tests/qa/integration/g-704-support.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-704 seed writes only into an isolated QA run');
}
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
const statePath = process.argv[2];
if (!authPath || !statePath)
  throw new Error('Usage: bun g-704-seed.ts <state file>, with REZICS_WEB_AUTH_PRIVATE_PATH set');
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as {
  principalId: string;
  actingSubject: string;
};

const L = await loopStack('g704-e2e');
try {
  /** One grant to the web member, as the member's own Agent, valid for the run. */
  const grantReader = async (scope: string, action: string) => {
    await L.f.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await L.f.accessPool.query(
      `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), reader.principalId, reader.actingSubject, action],
    );
    await L.f.accessPool.query(
      `INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), reader.actingSubject, scope, action],
    );
  };

  // The Swedish Work: the web member reads it and proposes corrections as a contributor; reviewers are API members.
  const sagan = await L.catalogueWork('Sagan om ringen', 'sv');
  await grantReader(`work:read:${sagan.work}`, 'work.read');

  // The wiki Work: the web member is its steward and applies what the assistant proposes.
  const wiki = await wikiWorld(L);
  await L.f.accessPool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [
    wiki.work.work,
    reader.actingSubject,
  ]);
  for (const [scope, action] of [
    [`work:read:${wiki.work.work}`, 'work.read'],
    [`work:review:${wiki.work.work}`, 'work.review'],
    [`work:edit:${wiki.work.work}`, 'work.edit'],
    ['semantic:create:root', 'semantic.change'],
    ['relation:create:root', 'relation.change'],
    [`statement:speak:${reader.actingSubject}`, 'statement.record'],
    [`statement:speak:${reader.actingSubject}`, 'statement.withdraw'],
    [`export:${wiki.work.work}`, 'export.create'],
    [`semantic:read:${wiki.property}`, 'semantic.read'],
    [`semantic:read:${wiki.relation}`, 'semantic.read'],
  ] as const) {
    await grantReader(scope, action);
  }
  const head = await L.head(wiki.work.work);
  const submitted = await submitWikiBundle(
    {
      send: async (envelope) => {
        const delivered = await L.call(
          envelope.method,
          envelope.path,
          envelope.body,
          L.assistant.token,
          envelope.headers['idempotency-key'],
        );
        return { status: delivered.status, body: (await delivered.json()) as unknown };
      },
    },
    {
      target: { resource: wiki.work.work, revision: head, context: 'urn:rezics:context:global' },
      bundle: wiki.bundle,
      baseHeads: [{ component: wiki.work.work, head }],
      evidence: [],
      actingSubject: L.assistant.actor,
    },
    `Bearer ${L.assistant.token}`,
    randomUUID(),
  );
  if (submitted.status !== 201)
    throw new Error(
      `The bundle was refused: ${submitted.status} ${JSON.stringify(submitted.body)}`,
    );
  const bundle = submitted.body as Command;

  const roles: Roles = {
    holder: memberState(L.holder),
    steward: memberState(L.steward),
    second: memberState(L.second),
    assistant: memberState(L.assistant),
  };
  const state = {
    roles,
    reader,
    sagan: { work: sagan.work, id: short(sagan.work) },
    wiki: {
      work: wiki.work.work,
      id: short(wiki.work.work),
      zone: wiki.zone,
      chapters: wiki.chapters.occurrences,
      property: wiki.property,
      relation: wiki.relation,
      bundleProposal: bundle.proposal,
      head,
    },
  };
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify(state));
} finally {
  await L.close();
}
