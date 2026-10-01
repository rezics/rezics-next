import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { seedWiki } from '../../../apps/web/tests/g-849-records.ts';
import { startMediaStack } from './media-support.ts';

test('G-849 exploration: dump the shapes the wiki Zone reads', async () => {
  const stack = await startMediaStack('g849x', { agents: true, rights: true, library: true });
  try {
    const reader = await stack.member('reader');
    const seed = await seedWiki(stack, { principalId: reader.principalId, actingSubject: reader.actor });
    seed.tokens.set(reader.token, reader.principal);
    const short = (iri: string) => iri.slice(-36);
    const out: Record<string, unknown> = { seed: { ...seed, read: undefined } };
    const get = async (label: string, path: string, token: string | null = null) => {
      const response = await seed.read(path, token);
      const text = await response.text();
      out[label] = { status: response.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    };
    for (const position of ['all']) {
      await get(`route:franchise:${position}`, `/v1/zones/${short(seed.zone)}/routes?path=/franchise&position=${position}`);
      await get(`route:characters:${position}`, `/v1/zones/${short(seed.zone)}/routes?path=/characters&position=${position}`);
      await get(`route:chapters:${position}`, `/v1/zones/${short(seed.zone)}/routes?path=/chapters&position=${position}`);
      for (const [key, iri] of Object.entries(seed.entities)) {
        await get(`page:${key}:${position}`, `/v1/resources/${short(iri)}/page?position=${position}`);
        await get(`statements:${key}:${position}`, `/v1/resources/${short(iri)}/statements?position=${position}`);
        await get(`relations:${key}:${position}`, `/v1/resources/${short(iri)}/relations?position=${position}`);
      }
      for (const [index, iri] of seed.chapters.entries()) await get(`page:chapter${index + 1}:${position}`, `/v1/resources/${short(iri)}/page?position=${position}`);
      for (const [index, iri] of seed.evidence.entries()) await get(`evidence:${index}:${position}`, `/v1/wiki/evidence/${short(iri)}?position=${position}`);
    }
    await get('holder:relations:elizabeth', `/v1/resources/${short(seed.entities.elizabeth!)}/relations?actingSubject=${encodeURIComponent(seed.holderActor)}&position=all`, seed.holderToken);
    await get('anon:statement-claim0', `/v1/statements/${short((out['evidence:0:all'] as { body: { claim: string } }).body.claim)}?position=all`);
    await get('anon:relation-claim1', `/v1/relations/${short((out['evidence:1:all'] as { body: { claim: string } }).body.claim)}?position=all`);
    const asReader = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader.actor)}`;
    await get('reader:relations:elizabeth', asReader(`/v1/resources/${short(seed.entities.elizabeth!)}/relations?position=all`), reader.token);
    await get('reader:relations:elizabeth:ch1', asReader(`/v1/resources/${short(seed.entities.elizabeth!)}/relations?position=${encodeURIComponent(seed.chapters[0]!)}`), reader.token);
    await get('reader:evidence1', asReader(`/v1/wiki/evidence/${short(seed.evidence[1]!)}?position=all`), reader.token);
    await get('chooser', `/v1/reading-positions/${short(seed.work)}`);
    await get('chooser:all', `/v1/reading-positions/${short(seed.work)}?position=all`);
    await get('anon:characters', `/v1/zones/${short(seed.zone)}/routes?path=/characters`);
    await get('ch1:characters', `/v1/zones/${short(seed.zone)}/routes?path=/characters&position=${encodeURIComponent(seed.chapters[0]!)}`);
    await get('ch1:darcy', `/v1/zones/${short(seed.zone)}/routes?path=/characters/${short(seed.entities.darcy!)}&position=${encodeURIComponent(seed.chapters[0]!)}`);
    await get('ch1:darcy-page', `/v1/resources/${short(seed.entities.darcy!)}/page?position=${encodeURIComponent(seed.chapters[0]!)}`);
    await get('summary:chapter', `/v1/resources/${short(seed.chapters[0]!)}`);
    await get('summary:property', `/v1/resources/${short(seed.entities.elizabeth!)}`);
    writeFileSync('/tmp/g849/explore.json', JSON.stringify(out, null, 2));
    expect(Object.keys(out).length).toBeGreaterThan(5);
  } finally { await stack.stop(); }
}, 600_000);
