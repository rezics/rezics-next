import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  ContentCore,
  contentDraftIntentDigest,
  type SaveDraftCommand,
} from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import {
  AccessAdmissionRegistry,
  type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { changeRealmMember } from '../src/modules/access/realm-management-members.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { governanceServices } from '../src/modules/governance/composition.ts';
import { publicReportOwners } from '../src/modules/public-report/owners.ts';
import { PublicReports } from '../src/modules/public-report/store.ts';
import { RealmReplyContentStore } from '../src/modules/realm-reply/content-store.ts';
import { replySlotIri } from '../src/modules/realm-reply/graph.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { publicReportRoutes } from '../src/routes/public-reports.ts';
import { reportRoutes } from '../src/routes/reports.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface ReplyReporter {
  principalId: string;
  principal: VerifiedPrincipal;
  actor: string;
  token: string;
}
export interface ReportingReply {
  reply: string;
  realm: string;
  variantId: string;
  revisionId: string;
  revisionDigest: string;
  reviewDecisionId: string;
  reviewGeneration: string;
  preparationId: string;
  placement: string;
}

/** One native owner template, copied without Docker or a live graph service. */
export async function replyReportAuthorityDatabase() {
  const root = resolve(import.meta.dir, '../../..');
  const directory = join(root, '.temp', `reply-report-authority-${randomUUID()}`),
    data = join(directory, 'pgdata');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const command = (name: string, args: string[]) =>
    execFileSync(name, args, { cwd: directory, stdio: 'pipe', timeout: 30_000 });
  let admin: Pool | undefined,
    started = false,
    count = 0;
  const copies = new Set<() => Promise<void>>();
  async function stop() {
    const errors: unknown[] = [];
    for (const close of [...copies])
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    admin = undefined;
    if (started)
      try {
        command('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '30', '-w', 'stop']);
        started = false;
      } catch (error) {
        errors.push(error);
      }
    if (!started) rmSync(directory, { recursive: true, force: true });
    if (errors.length)
      throw new AggregateError(errors, 'Reply reporting PostgreSQL cleanup failed');
  }
  try {
    command('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync']);
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('No reply reporting PostgreSQL port'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePort(address.port)));
      });
    });
    started = true;
    command('pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-t',
      '30',
      '-w',
      'start',
    ]);
    const config = {
      host: '127.0.0.1',
      port,
      user: process.env.USER,
      connectionTimeoutMillis: 30_000,
    };
    admin = new Pool({ ...config, database: 'postgres', max: 1 });
    await admin.query('CREATE DATABASE reply_report_template');
    const template = new Pool({ ...config, database: 'reply_report_template', max: 1 });
    try {
      for (const file of schemaFiles(root, 'access'))
        await template.query(
          readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'),
        );
      await migrateContent(template);
    } finally {
      await template.end();
    }
    return {
      fixture: async () => {
        const database = `reply_report_copy_${++count}`;
        await admin!.query(`CREATE DATABASE ${database} TEMPLATE reply_report_template`);
        const accessPool = new Pool({ ...config, database }),
          contentPool = new Pool({ ...config, database });
        let poolsClosed = false,
          closed = false;
        const close = async () => {
          if (closed) return;
          if (!poolsClosed) {
            await Promise.all([accessPool.end(), contentPool.end()]);
            poolsClosed = true;
          }
          await admin!.query(`DROP DATABASE ${database} WITH (FORCE)`);
          closed = true;
          copies.delete(close);
        };
        copies.add(close);
        return createReplyReportFixture(accessPool, contentPool, close);
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Reply reporting PostgreSQL setup and cleanup failed',
      );
    }
    throw error;
  }
}

async function createReplyReportFixture(
  accessPool: Pool,
  contentPool: Pool,
  stop: () => Promise<void>,
) {
  const work = native(),
    rootRevision = native(),
    epoch = randomUUID();
  const publicRealm = native(),
    privateRealm = native();
  const realmSpaces = new Map([
    [publicRealm, native()],
    [privateRealm, native()],
  ]);
  const placements = new Map<string, ReportingReply>();
  const graphQueries: string[] = [];
  const graph = { authorityDown: false };
  const workReadCalls: string[] = [];
  const scopeChecks: string[][] = [];
  const deniedScopes = new Set<string>();
  const uri = (value: string) => ({ type: 'uri' as const, value });
  const literal = (value: string) => ({ type: 'literal' as const, value });
  const position = () => ({ epoch: literal(epoch), sequence: literal('1') });
  const bindings = (
    rows: Array<Record<string, { type: 'uri' | 'literal'; value: string; 'xml:lang'?: string }>>,
  ) => ({ results: { bindings: rows } });
  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await accessPool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function person(): Promise<ReplyReporter> {
    const principalId = randomUUID(),
      actor = native(),
      token = randomUUID();
    const principal: VerifiedPrincipal = {
      issuer: 'urn:reply-report:account',
      subject: randomUUID(),
      emailVerified: true,
    };
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
        [principalId, principal.issuer, principal.subject],
      );
      await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
        actor,
      ]);
      await client.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`,
        [randomUUID(), principalId, actor],
      );
    });
    return { principalId, principal, actor, token };
  }
  try {
    const author = await person(),
      reader = await person(),
      moderator = await person(),
      outsider = await person();
    const people = [author, reader, moderator, outsider];
    const access = new AccessAdmissionRegistry(accessPool);
    const canReadWork = access.canReadWork.bind(access);
    access.canReadWork = (principal, actor, resource) => {
      workReadCalls.push(resource);
      return canReadWork(principal, actor, resource);
    };
    const content = new ContentCore(contentPool),
      replyOwner = new RealmReplyContentStore(contentPool);
    const fuseki = new FusekiClient('http://reply-report-graph.invalid');
    fuseki.query = async (raw) => {
      graphQueries.push(raw);
      if (graph.authorityDown) throw new Error('Reply reporting graph authority is unavailable');
      const query = raw.replace(/\s+/g, ' ').trim();
      if (/ASK \{ GRAPH <urn:rezics:graph:control>/.test(query) && query.includes('rv:restoreHold'))
        return { boolean: query.includes(epoch) };
      if (/SELECT \?epoch \?sequence WHERE/.test(query)) return bindings([position()]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head')) {
        if (!query.includes(`<${work}>`)) return bindings([position()]);
        return bindings([
          {
            ...position(),
            r: uri(work),
            type: literal('work'),
            work: uri(work),
            head: uri(rootRevision),
            public: literal('true'),
            label: { ...literal('Public reply root'), 'xml:lang': 'en' },
          },
        ]);
      }
      if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type ?mergedInto'))
        return bindings(
          query.includes(`<${work}>`)
            ? [
                {
                  ...position(),
                  r: uri(work),
                  revision: uri(rootRevision),
                  type: uri('https://schema.org/CreativeWork'),
                },
              ]
            : [position()],
        );
      if (query.includes('SELECT ?root WHERE') && query.includes(`<${rootRevision}>`))
        return bindings([{ root: uri(rootRevision) }]);
      if (
        query.includes('SELECT ?resource ?head ?manifest') ||
        query.includes('SELECT ?resource ?manifest')
      )
        return bindings([]);
      if (query.includes('SELECT ?work ?head ?owningWork ?owningHead'))
        return bindings([
          {
            work: uri(work),
            head: uri(rootRevision),
            owningWork: uri(work),
            owningHead: uri(rootRevision),
          },
        ]);
      if (query.includes('SELECT ?work ?head ?nameOwner'))
        return bindings([{ work: uri(work), head: uri(rootRevision) }]);
      if (query.includes('SELECT ?space ?realmRevision ?disclosure ?visibility ?mode ?head')) {
        const realm = [...realmSpaces.keys()].find((value) => query.includes(`<${value}>`));
        return bindings(
          realm
            ? [
                {
                  space: uri(realmSpaces.get(realm)!),
                  realmRevision: uri(rootRevision),
                  disclosure: uri(RV + (realm === privateRealm ? 'Private' : 'Public')),
                  visibility: literal(realm === privateRealm ? 'private' : 'public'),
                  mode: literal('mandatory'),
                },
              ]
            : [],
        );
      }
      if (
        query.includes(
          '?placement ?revision ?review ?root ?author ?preparation ?rootRevision WHERE',
        )
      ) {
        const reply = [...placements.values()].find((value) =>
          query.includes(`<${replySlotIri(value.realm, value.reply)}>`),
        );
        return bindings(
          reply
            ? [
                {
                  placement: uri(reply.placement),
                  revision: uri(`urn:rezics:content:revision:${reply.revisionId}`),
                  review: uri(`urn:rezics:realm-review:${reply.reviewDecisionId}`),
                  root: uri(work),
                  author: uri(author.actor),
                  preparation: literal(reply.preparationId),
                  rootRevision: literal(rootRevision),
                },
              ]
            : [],
        );
      }
      if (
        query.includes('SELECT ?r ?revision ?type WHERE') ||
        query.includes('SELECT ?r ?mergedInto WHERE')
      )
        return bindings([]);
      if (query.includes('SELECT ?r ?contentRevision ?realm WHERE')) {
        return bindings(
          [...placements.values()]
            .filter((value) => value.realm === publicRealm && query.includes(`<${value.reply}>`))
            .map((value) => ({
              r: uri(value.reply),
              contentRevision: uri(`urn:rezics:content:revision:${value.revisionId}`),
              realm: uri(value.realm),
            })),
        );
      }
      if (
        query.includes('SELECT ?author ?realm WHERE') ||
        query.includes('SELECT DISTINCT ?author WHERE')
      ) {
        const reply = [...placements.values()].find((value) => query.includes(`<${value.reply}>`));
        return bindings(reply ? [{ author: uri(author.actor), realm: uri(reply.realm) }] : []);
      }
      throw new Error(`Unexpected reply reporting graph query: ${query}`);
    };
    const env: WorkActivationEnvironment = {
      fuseki,
      lineage: { dataEpoch: epoch, routingEpoch: '1' },
      objectDirectory: '.temp/reply-report-objects',
    };
    const replies = new RealmReplyStore(replyOwner, content, access, env);
    const governance = governanceServices(
      accessPool,
      contentPool,
      content,
      new SourceIntakeStore(contentPool),
      access,
      env,
    );
    configureDisclosure(env, new DisclosureStore(accessPool));
    const deps: MainWorkDependencies = {
      environment: env,
      access,
      content,
      contentAuthoring: content,
      realmReplies: replies,
      governance,
      account: {
        verify: async (request, requiredScopes) => {
          scopeChecks.push([...requiredScopes]);
          if (requiredScopes.some((scope) => deniedScopes.has(scope)))
            throw new AccountAssertionDenied('Fixture OAuth scope denied');
          const person = people.find(
            (value) => request.headers.get('authorization') === `Bearer ${value.token}`,
          );
          if (!person) throw new AccountAssertionDenied('Unknown fixture bearer');
          return person.principal;
        },
      },
    };
    deps.publicReports = new PublicReports(
      accessPool,
      publicReportOwners(deps, contentPool, content),
    );
    const app = new Elysia().use(reportRoutes(deps)).use(publicReportRoutes(deps));
    async function grant(person: ReplyReporter, scope: string, action: string) {
      await transaction(async (client) => {
        await client.query(
          'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
          [scope],
        );
        await client.query(
          `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
          VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
          [randomUUID(), person.principalId, person.actor, action],
        );
        await client.query(
          `INSERT INTO access.permission_grant
          (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
          [randomUUID(), person.actor, scope, action],
        );
      });
    }
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING",
      );
      for (const realm of realmSpaces.keys()) {
        await client.query(
          "INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')",
          [realm],
        );
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [
          `governance:realm:${realm}`,
        ]);
        await client.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [realm]);
        await client.query(
          `INSERT INTO access.realm_admin_settings (realm,visibility,who_may_submit)
          VALUES ($1,$2,'members')`,
          [realm, realm === privateRealm ? 'private' : 'public'],
        );
        await client.query(
          `INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
          VALUES ('realm',$1,0,'fixture-terms')`,
          [realm],
        );
        for (const person of [author, reader, moderator]) {
          const id = randomUUID(),
            consent = `urn:fixture:consent:${randomUUID()}`;
          await client.query(
            `INSERT INTO access.membership
            (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
            VALUES ($1,'realm',$2,$3,'joined',1,0,'fixture-terms',$4)`,
            [id, realm, person.actor, consent],
          );
          await client.query(
            `INSERT INTO access.membership_history
            (membership_id,generation,state,policy_revision,terms_revision,consent_reference,changed_by_principal)
            VALUES ($1,1,'joined',0,'fixture-terms',$2,$3)`,
            [id, consent, person.principalId],
          );
        }
      }
    });
    await grant(author, `reply:create:${work}`, 'reply.create');
    for (const realm of realmSpaces.keys()) {
      await grant(author, `reply:place:${realm}`, 'reply.place');
      await grant(moderator, `review:decide:${realm}`, 'review.decide');
      await grant(moderator, `governance:realm:${realm}`, 'governance.moderate');
      await grant(moderator, `governance:realm:${realm}`, 'governance.rule.publish');
    }
    async function admit(
      person: ReplyReporter,
      action: string,
      scope: string,
      requestDigest = digest(randomUUID()),
    ) {
      const registered = await access.register({
        principal: person.principal,
        actingSubject: person.actor,
        action,
        scope,
        idempotencyKey: randomUUID(),
        requestDigest,
      });
      return access.claim(registered.id, requestDigest, person.principal);
    }
    async function saveBody(
      reply: string,
      variantId: string,
      realm: string,
      expectedHead: string | null,
      body: string,
    ) {
      const command: SaveDraftCommand = {
        operationId: '',
        variant: {
          id: variantId,
          resourceId: reply,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr',
        },
        expectedHead,
        model: 'member-reply-v1',
        sourceRevision: rootRevision,
        provenance: {},
        serializedJson: JSON.stringify({
          body,
          deleted: false,
          rootTarget: work,
          rootRevision,
          originRealm: realm,
        }),
      };
      const requestDigest = contentDraftIntentDigest(command, author.actor);
      const admission = await admit(
        author,
        'content.draft',
        `content:draft:${reply}`,
        requestDigest,
      );
      command.operationId = `content-draft:${admission.id}`;
      command.provenance = {
        kind: 'admitted-original-contribution-v1',
        author: author.actor,
        admissionId: admission.id,
        authorityEpoch: admission.authorityEpoch,
        scope: admission.scope,
        requestDigest,
        expectedHead,
        rightsBasis: 'original-contribution',
      };
      const saved = await content.saveDraft(command);
      if (!saved.revisionId) throw new Error('Fixture draft was not saved');
      return { revisionId: saved.revisionId, revisionDigest: digest(command.serializedJson) };
    }
    async function createReply(
      options: { private?: boolean; body?: string } = {},
    ): Promise<ReportingReply> {
      const reply = native(),
        variantId = `urn:rezics:variant:${randomUUID()}`;
      const realm = options.private ? privateRealm : publicRealm;
      await grant(author, `content:draft:${reply}`, 'content.draft');
      const body = await saveBody(
        reply,
        variantId,
        realm,
        null,
        options.body ?? 'Exact private moderation evidence',
      );
      await replyOwner.createReply(await admit(author, 'reply.create', `reply:create:${work}`), {
        reply,
        variantId,
        ...body,
        author: author.actor,
        rootTarget: work,
        rootRevision,
        originRealm: realm,
        parentReply: null,
        parentRevision: null,
        contextRevision: null,
      });
      const review = await replyOwner.decideReview(
        await admit(moderator, 'review.decide', `review:decide:${realm}`),
        {
          realm,
          reply,
          ...body,
          expectedGeneration: '0',
          supersedes: null,
          outcome: 'approved',
          method: 'human',
          methodRevision: 'fixture-review',
          dependencyDigest: digest(rootRevision),
          reasonReference: null,
        },
      );
      const preparation = await replyOwner.preparePlacement(
        await admit(author, 'reply.place', `reply:place:${realm}`),
        { realm, reply, ...body, reviewDecisionId: review.decisionId, expectedHead: null },
      );
      const placement = native();
      await content.settlePublication(
        `${preparation.operationId}:settle`,
        preparation.operationId,
        {
          outcome: 'active',
          revisionId: body.revisionId,
          receipt: placement,
          dataEpoch: epoch,
          sequence: '1',
        },
      );
      const result = {
        reply,
        realm,
        variantId,
        ...body,
        reviewDecisionId: review.decisionId,
        reviewGeneration: review.generation,
        preparationId: preparation.operationId,
        placement,
      };
      placements.set(reply, result);
      return result;
    }
    async function post(
      path: string,
      body: object,
      person: ReplyReporter | null = reader,
      key = randomUUID(),
    ) {
      const response = await app.handle(
        new Request(`http://main.local${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
            ...(person ? { authorization: `Bearer ${person.token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    function reportBody(
      reply: ReportingReply,
      person = reader,
      overrides: Record<string, unknown> = {},
    ) {
      return {
        profile: 'content-report-v1',
        actingSubject: person.actor,
        authority: { kind: 'realm', scopeId: `governance:realm:${reply.realm}` },
        context: reply.realm,
        target: { owner: 'content', resource: reply.reply, component: 'body' },
        disclosure: 'private',
        reasonCode: 'abuse',
        statement: 'Please review this reply',
        evidence: [
          {
            owner: 'content',
            resource: reply.reply,
            component: 'body',
            revision: reply.revisionId,
            locator: null,
          },
        ],
        idempotencyKey: randomUUID(),
        ...overrides,
      };
    }
    return {
      accessPool,
      contentPool,
      access,
      content,
      replyOwner,
      replies,
      env,
      fuseki,
      deps,
      app,
      governance,
      author,
      reader,
      moderator,
      outsider,
      work,
      rootRevision,
      publicRealm,
      privateRealm,
      graph,
      graphQueries,
      workReadCalls,
      scopeChecks,
      deniedScopes,
      createReply,
      post,
      reportBody,
      read: (reply: ReportingReply, person: ReplyReporter | null = reader) =>
        replies.readPublic(reply.reply, person?.principal, person?.actor),
      editReply: (reply: ReportingReply, body = 'Edited reply') =>
        saveBody(reply.reply, reply.variantId, reply.realm, reply.revisionId, body),
      revokeApproval: async (reply: ReportingReply) =>
        replyOwner.decideReview(
          await admit(moderator, 'review.decide', `review:decide:${reply.realm}`),
          {
            realm: reply.realm,
            reply: reply.reply,
            revisionId: reply.revisionId,
            revisionDigest: reply.revisionDigest,
            expectedGeneration: reply.reviewGeneration,
            supersedes: reply.reviewDecisionId,
            outcome: 'revoked',
            method: 'human',
            methodRevision: 'fixture-review',
            dependencyDigest: digest(rootRevision),
            reasonReference: 'moderation-revocation',
          },
        ),
      revokeMembership: async (person: ReplyReporter, realm: string) =>
        transaction(async (client) => {
          const row = (
            await client.query<{ generation: string }>(
              `SELECT generation::text FROM access.membership
          WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
              [realm, person.actor],
            )
          ).rows[0]!;
          return changeRealmMember(
            client,
            realm,
            {
              actingSubject: moderator.actor,
              expectedGeneration: '0',
              reason: 'Revoke access',
              member: person.actor,
              expectedMembershipGeneration: row.generation,
              action: 'remove',
              consent: null,
              durationSeconds: null,
            },
            moderator.principalId,
            randomUUID(),
          );
        }),
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Reply reporting fixture setup and cleanup failed',
      );
    }
    throw error;
  }
}
