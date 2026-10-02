import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { firstPartyExecution, readFirstPartyTheme, writeFirstPartyTheme }
  from '../../../services/main/src/modules/theme/first-party-lifecycle.ts';
import { ThemePending } from '../../../services/main/src/modules/theme/activation.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** A reviewed byte manifest is the only package that can reach a public Zone. */
test('VIEW09: first-party create, immutable review, host activation, revoke and kill recovery', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `theme-first-party-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit owner:operate theme:approve theme:read');
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const settle = async (method: string, path: string, body: object) => {
      const key = randomUUID();
      let pending = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await f.call(method, path, body, key);
        if (response.status !== 202) return response;
        pending = await response.text();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${path} remained pending: ${pending}`);
    };
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(await settle('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Theme host', capabilities: ['realm'], actingSubject: f.actor,
    }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.json<{ revision: string }>(await settle('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: f.actor,
    }), 201);
    await f.grant(`zone:official:${zone}`, 'zone.official');
    const theme = nativeId();
    for (const [scope, action] of [
      ['theme:create:root', 'theme.create'],
      [`theme:revise:${shortId(theme)}`, 'theme.revise'],
      [`theme:review:${shortId(theme)}`, 'theme.review'],
      [`theme:activate:${shortId(theme)}`, 'theme.activate'],
      [`theme:revoke:${shortId(theme)}`, 'theme.revoke'],
      ['theme:control:global', 'theme.control'],
    ]) await f.grant(scope, action);
    const reviewer = nativeId();
    await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [reviewer]);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`theme:review:${shortId(theme)}`]);
    await f.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'theme.review',now() + interval '1 hour')`,
    [randomUUID(), f.otherPrincipal, reviewer]);
    await f.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'theme.review',now() + interval '1 hour')`,
    [randomUUID(), f.principalId, reviewer]);
    await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'theme.review',now() + interval '1 hour')`,
    [randomUUID(), reviewer, `theme:review:${shortId(theme)}`]);
    const app = createMainApp(f.env.fuseki, { environment: f.env,
      account: f.account.verifier, access: f.access });
    const call = (method: string, path: string, body: object, token = f.account.tokenA,
      key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify({ ...body, idempotencyKey: key }),
    }));
    const created = await f.json<{ operation: string }>(await call('POST', '/v1/themes', {
      theme: shortId(theme), owner: f.actor, hostZone: zone, actingSubject: f.actor,
    }), 201);
    expect(created.operation).toStartWith('https://rezics.com/id/');
    const bundle = { profile: 'first-party-bundle-v1', hostZone: zone, entry: 'assets/main.js',
      files: [{ path: 'assets/main.js', digest: digest('main'), gzipBytes: 100 }],
      slots: ['hero'], connectOrigins: [], imageOrigins: [], fontOrigins: [] };
    const revised = await f.json<{ operation: string }>(await call('POST',
      `/v1/themes/${shortId(theme)}/revisions`, {
        expectedRevision: null, bundle, actingSubject: f.actor,
      }), 201);
    const emptyTheme = nativeId();
    await f.json(await call('POST', '/v1/themes', {
      theme: shortId(emptyTheme), owner: f.actor, hostZone: zone, actingSubject: f.actor,
    }), 201);
    const empty = await app.handle(new Request(`http://main.local/v1/themes/${shortId(emptyTheme)}/first-party`, {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ revision: null, bundle: null,
      activation: null, decision: null });
    expect((await call('POST', `/v1/themes/${shortId(theme)}/revisions`, {
      expectedRevision: null, bundle, actingSubject: f.actor,
    })).status).toBe(409);
    const sameActor = await call('POST',
      `/v1/themes/${shortId(theme)}/revisions/${shortId(revised.operation)}/reviews`, {
        decision: 'approved', reviewEvidenceDigest: digest('reviewed source and build'),
        actingSubject: f.actor,
      });
    expect(sameActor.status).toBe(409);
    const sameAccount = await call('POST',
      `/v1/themes/${shortId(theme)}/revisions/${shortId(revised.operation)}/reviews`, {
        decision: 'approved', reviewEvidenceDigest: digest('reviewed source and build'),
        actingSubject: reviewer,
      });
    expect(sameAccount.status).toBe(409);
    const reviewerDecision = await f.json<{ operation: string; receipt: string }>(await call('POST',
      `/v1/themes/${shortId(theme)}/revisions/${shortId(revised.operation)}/reviews`, {
        decision: 'approved', reviewEvidenceDigest: digest('reviewed source and build'),
        actingSubject: reviewer,
      }, f.account.tokenB), 201);
    expect(reviewerDecision.operation).toStartWith('https://rezics.com/id/');
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:revisions> { <${reviewerDecision.operation}>
        rv:reviewEvidenceDigest "${digest('reviewed source and build')}" . }
      GRAPH <urn:rezics:graph:receipts> { <${reviewerDecision.receipt}>
        rv:outcome rv:Succeeded . } }`)).boolean).toBe(true);
    const activation = await f.json<{ operation: string; receipt: string }>(await call('POST',
      `/v1/themes/${shortId(theme)}/first-party-activations`, {
        revision: revised.operation, expectedActivation: null,
        approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(), actingSubject: f.actor,
      }), 201);
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:outbox> { ?event a rv:FirstPartyThemeActivateEvent ;
        rv:receipt <${activation.receipt}> . } }`)).boolean).toBe(true);
    const presentation = { ...DEFAULT_ZONE_PRESENTATION, official: { theme } };
    await f.json(await settle('PUT', `/v1/zones/${shortId(zone)}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
      actingSubject: f.actor, defaultRealm: space.realm,
      official: {}, presentation,
    }), 200);
    const publicUrl = `http://main.local/v1/zones/${shortId(zone)}/presentation`;
    const active = await app.handle(new Request(publicUrl));
    expect(active.status).toBe(200);
    expect(active.headers.get('cache-control')).toBe('no-store');
    expect(await active.json()).toMatchObject({ execution: { state: 'active',
      activation: activation.operation, package: bundle } });
    const activeView = await readFirstPartyTheme(f.env, shortId(theme));
    expect(firstPartyExecution(activeView, zone,
      Date.parse(activeView!.approvalExpiresAt!) + 1)).toEqual({ state: 'fallback', reason: 'expired' });
    const revokeKey = randomUUID();
    let interrupted = false;
    await expect(writeFirstPartyTheme(f.env, f.account.verifier, {
      register: (...args) => f.access.register(...args),
      claim: (...args) => f.access.claim(...args),
      recordGraphOutcome: async () => { interrupted = true; throw new Error('injected Access interruption'); },
    }, new Request(`http://main.local/v1/themes/${shortId(theme)}/revocations`, {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }), { action: 'revoke', theme: shortId(theme), expectedActivation: activation.operation,
      actingSubject: f.actor, idempotencyKey: revokeKey })).rejects.toBeInstanceOf(ThemePending);
    expect(interrupted).toBe(true);
    const recovered = await f.json<{ replayed: boolean }>(await call('POST',
      `/v1/themes/${shortId(theme)}/revocations`, {
        expectedActivation: activation.operation, actingSubject: f.actor,
      }, f.account.tokenA, revokeKey), 200);
    expect(recovered.replayed).toBe(true);
    const revoked = await app.handle(new Request(publicUrl));
    expect(await revoked.json()).toMatchObject({ execution: { state: 'fallback', reason: 'revoked' } });
    const killedControl = await f.json<{ operation: string }>(await call('PUT', '/v1/themes/execution-control', {
      disabled: true, expectedControl: null, actingSubject: f.actor,
    }), 201);
    const killed = await app.handle(new Request(publicUrl));
    expect(await killed.json()).toMatchObject({ execution: { state: 'fallback',
      reason: 'globally_disabled' } });
    const controlRead = await app.handle(new Request('http://main.local/v1/themes/execution-control', {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }));
    expect(controlRead.status).toBe(200);
    expect(await controlRead.json()).toMatchObject({ disabled: true,
      control: killedControl.operation });
    await f.json(await call('PUT', '/v1/themes/execution-control', {
      disabled: false, expectedControl: killedControl.operation, actingSubject: f.actor,
    }), 201);
    expect(await (await app.handle(new Request(publicUrl))).json()).toMatchObject({
      execution: { state: 'fallback', reason: 'none_approved' },
    });
    const revisions = await Promise.all(['a', 'b'].map(value => call('POST',
      `/v1/themes/${shortId(theme)}/revisions`, {
        expectedRevision: revised.operation, actingSubject: f.actor,
        bundle: { ...bundle, files: [{ ...bundle.files[0], digest: digest(value) }] },
      })));
    expect(revisions.map(response => response.status).sort()).toEqual([201, 409]);
  } finally { await f.close(); }
}, 90_000);
