// One request to Main as an API member of the G-704 seed (a steward, second reviewer, contributor or assistant),
// sent through a Main app attached to the same isolated QA stack the browser reads. Prints `{ status, body }`.
//   bun g-704-act.ts <state file> '{"as":"steward","method":"POST","path":"/v1/…","body":{…}}'
// or `{"revoke":"assistant"}` to end the assistant's credential.
import { readFileSync } from 'node:fs';
import { loopStack, type Roles } from '../../../tests/qa/integration/g-704-support.ts';

const [statePath, requestJson] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '') || !statePath || !requestJson) {
  throw new Error('Usage: bun g-704-act.ts <state file> <request json>, inside an isolated QA run');
}
const { roles } = JSON.parse(readFileSync(statePath, 'utf8')) as { roles: Roles };
const request = JSON.parse(requestJson) as { as?: keyof Roles; method?: string; path?: string; body?: object; key?: string;
  revoke?: 'assistant'; settle?: boolean };
const L = await loopStack('g704-act', roles);
try {
  if (request.revoke) {
    await L.revokeCredential(L.assistant);
    console.log(JSON.stringify({ status: 200, body: { revoked: request.revoke } }));
  } else {
    const who = L[request.as!];
    // Ordered owners answer 202 until their bounded deliveries finish; the same key finishes them.
    const key = request.key ?? crypto.randomUUID();
    let response = await L.call(request.method!, request.path!, request.body, who.token, key);
    for (let attempt = 0; request.settle && response.status === 202 && attempt < 100; attempt++) {
      await response.text();
      response = await L.call(request.method!, request.path!, request.body, who.token, key);
    }
    console.log(JSON.stringify({ status: response.status, body: await response.json().catch(() => null) }));
  }
} finally {
  await L.close();
}
