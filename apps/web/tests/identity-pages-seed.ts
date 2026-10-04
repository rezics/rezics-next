// Domain records are seeded through Main's public commands; only fixture authentication and grants use the QA stores.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import {
  seedRelationLexicon,
  seedVariantKindConcepts,
} from '../../../scripts/dev/seed/relation-lexicon.ts';

if (!process.env.REZICS_QA_RUN_ID || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH)
  throw new Error('Use the browser QA stack');
const web = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH, 'utf8')) as {
  principalId: string;
  actingSubject: string;
};
const stack = await startMediaStack('identity-pages', { library: true });
const editor = await stack.member('identity-editor');
const people = [editor];
const app = createMainApp(stack.fuseki, {
  environment: stack.env,
  access: stack.access,
  targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
  account: {
    verify: async (request) => {
      const person = people.find(
        (item) => `Bearer ${item.token}` === request.headers.get('authorization'),
      );
      if (!person) throw new Error('Unknown fixture bearer');
      const principal = { ...person.principal, emailVerified: true };
      return { ...principal, currentAssertion: async () => principal };
    },
  },
});

async function call<T>(
  path: string,
  body?: object,
  person = editor,
  key: string = randomUUID(),
): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await app.handle(
      new Request(`http://main.local${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${person.token}`,
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await response.text();
    if (response.ok && response.status !== 202) return JSON.parse(text) as T;
    if (![202, 409, 503].includes(response.status) || attempt === 39)
      throw new Error(`${path}: ${response.status} ${text.slice(0, 500)}`);
    await Bun.sleep(250);
  }
  throw new Error('Fixture command did not settle');
}

const grantReader = async (ref: string) => {
  const scope = `semantic:read:${ref}`;
  await stack.accessPool.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [scope],
  );
  await stack.accessPool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'semantic.read',now() + interval '1 hour')`,
    [randomUUID(), web.principalId, web.actingSubject],
  );
  await stack.accessPool.query(
    `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$2,$3,'semantic.read',now() + interval '1 hour')`,
    [randomUUID(), web.actingSubject, scope],
  );
};

try {
  await editor.grant('semantic:create:root', 'semantic.change');
  await editor.grant('relation:create:root', 'relation.change');
  await editor.grant('classification:define:global', 'classification.proposition.define');
  const client = {
    post: <T>(path: string, body: object, key: string) => call<T>(path, body, editor, key),
    authorizeDefinition: async (receipt: { component: string }) => {
      await editor.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      await editor.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      await grantReader(receipt.component);
    },
  };
  const keys = ['variant-of', 'represents', 'holds-title'];
  const definitions = await seedRelationLexicon(
    client,
    editor.actor,
    `identity-${process.env.REZICS_QA_RUN_ID}`,
    relationLexiconSeed.filter((item) => keys.includes(item.key)),
  );
  const kinds = await seedVariantKindConcepts(
    client,
    editor.actor,
    `identity-${process.env.REZICS_QA_RUN_ID}`,
  );
  for (const ref of Object.values(kinds)) {
    await editor.grant(`semantic:read:${ref}`, 'semantic.read');
    await grantReader(ref);
  }
  const resource = async (name: string, type: string) => {
    const result = await call<{ component: string }>('/v1/semantic/changes', {
      profile: 'semantic-change-v1',
      expectedHead: null,
      actingSubject: editor.actor,
      state: {
        component: 'resource',
        types: [`https://rezics.com/vocab/${type}`],
        properties: [
          {
            predicate: 'https://schema.org/name',
            value: { kind: 'language-string', lexical: name, language: 'en', direction: 'ltr' },
          },
        ],
      },
    });
    await editor.grant(`semantic:read:${result.component}`, 'semantic.read');
    await grantReader(result.component);
    return result.component;
  };
  const saber = await resource('Saber', 'Character');
  const alter = await resource('Saber Alter', 'Character');
  const counterpart = await resource('Artoria (another world)', 'Character');
  const unit = await resource('Saber unit', 'GameUnit');
  const title = await resource('King of Knights', 'Title');
  const holder = await resource('Arthur', 'Character');
  const continuity = await resource('Fate/stay night', 'NarrativeContinuity');
  const otherContinuity = await resource('Fate/Prototype', 'NarrativeContinuity');
  const relation = async (
    key: string,
    refs: Record<string, string>,
    applicability: string[] = [],
  ) => {
    const definition = definitions.find((item) => item.key === key)!;
    const made = await call<{ occurrence: string }>('/v1/relations/changes', {
      profile: 'relation-change-v1',
      expectedHead: null,
      definition: definition.revision,
      actingSubject: editor.actor,
      applicability,
      participations: Object.entries(refs).map(([role, ref]) => ({
        role,
        participant: { kind: 'resource', ref },
        ...(ref === alter && role !== 'hub'
          ? { creditedName: { lexical: 'Saber', language: 'en' } }
          : {}),
      })),
    });
    await editor.grant(`semantic:read:${made.occurrence}`, 'semantic.read');
    await grantReader(made.occurrence);
  };
  await relation('variant-of', { hub: saber, variant: alter, kind: kinds.persona });
  await relation('variant-of', { hub: saber, variant: counterpart, kind: kinds.counterpart });
  await relation('represents', { character: saber, unit });
  await relation('holds-title', { title, holder: alter }, [continuity]);
  await relation('holds-title', { title, holder }, [otherContinuity]);
  await editor.grant('space:create:root', 'space.create');
  const { realm } = await call<{ realm: string }>('/v1/spaces', {
    profile: 'space-realm-v1',
    name: 'Identity ratings',
    language: 'en',
    capabilities: ['realm'],
    actingSubject: editor.actor,
  });
  await editor.grant(`rating:context:${realm}`, 'rating.context.create');
  const { context } = await call<{ context: string }>('/v1/rating-contexts', {
    profile: 'realm-target-rating-context-v2',
    realm,
    language: 'en',
    question: 'How do you rate this identity?',
    targetGrain: 'resource',
    actingSubject: editor.actor,
  });
  for (let i = 0; i < 5; i++) {
    const person = await stack.member(`identity-rater-${i}`);
    people.push(person);
    await person.grant(`rating:observe:${context}`, 'rating.observation.set');
    for (const target of [saber, ...(i === 0 ? [alter, unit] : [])]) {
      await person.grant(`semantic:read:${target}`, 'semantic.read');
      await call(
        '/v1/rating-observations',
        {
          profile: 'realm-target-rating-observation-v1',
          context,
          target,
          value: target === saber ? 8 : target === alter ? 9 : 6,
          expectedRevisionHead: null,
          actingSubject: person.actor,
        },
        person,
      );
    }
  }
  console.log(
    JSON.stringify({
      saber,
      alter,
      counterpart,
      unit,
      title,
      holder,
      realm,
      continuity,
      otherContinuity,
    }),
  );
} finally {
  await stack.stop();
}
