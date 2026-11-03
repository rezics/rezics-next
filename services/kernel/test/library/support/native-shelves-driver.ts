import { compileCatalogue } from '@rezics/definitions/compile';
import type {
  LibraryShelvesDriver,
  ShelvesInspection,
  StoredEntry,
  SourceStamp,
} from '../../../../../specs/library-shelves-driver.ts';
import { createLibraryDriver } from './outcome-driver.ts';
import { profileSources, profileTypes } from './native-conformance-profiles.ts';
import { json, publish, setGate, unavailable, write } from './native-conformance.ts';
import { createNativeShelvesGrowthFixture } from './native-shelves-growth-fixture.ts';
import { costOf } from '../../support/growth.ts';

const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function createLibraryShelvesDriver(): Promise<LibraryShelvesDriver> {
  const world = await createLibraryDriver();
  try {
    const sources = profileSources('profile-v1');
    await publish(world, await compileCatalogue(sources));
    const database = world.native.reader;
    const accounts = Object.values(world.accounts).map((account) => account.id);
    const growth = createNativeShelvesGrowthFixture(world, {
      type: profileTypes.book,
      trackAccount(accountId) {
        if (!accounts.includes(accountId)) accounts.push(accountId);
      },
    });
    const driver: LibraryShelvesDriver = {
      accounts: world.accounts,
      unknownSubjectId: world.unknown.subjectId,
      types: { book: profileTypes.book, anime: profileTypes.anime, game: profileTypes.game },
      setTime: world.setTime,
      now: world.now,
      async ageCursors(milliseconds) {
        await world.setTime(new Date(Date.parse(world.now()) + milliseconds).toISOString());
      },
      provisionSubject: (input) => world.native.subject(input?.type ?? profileTypes.book),
      async provisionSubjects(count, input) {
        const subjects = [];
        for (let i = 0; i < count; i++) subjects.push(await driver.provisionSubject(input));
        return subjects;
      },
      async installTypes(types) {
        const schema = JSON.parse(sources.schemas['fixture.yaml']!);
        schema.prefixes.shelf = 'https://example.org/shelf/';
        for (const [index, type] of types.entries()) schema.classes[`Shelf${index}`] = { class_uri: type };
        sources.schemas['fixture.yaml'] = JSON.stringify(schema);
        for (const [key, source] of Object.entries(sources.presentation)) {
          if (!key.startsWith('fixture/')) continue;
          const labels = JSON.parse(source);
          for (const type of types) labels.types[type] = 'Shelf type';
          sources.presentation[key] = JSON.stringify(labels);
        }
        await publish(world, await compileCatalogue(sources));
      },
      async forceTypeDigestCollision() {
        return unavailable('production shelf dictionary digest injection dependency');
      },
      async pauseTypeWork(input) {
        return unavailable(`production shelf ${input.workflow} ${input.boundary} observation latch`);
      },
      async changeSubjectType() {
        return unavailable('semantic primary-type revision command binding');
      },
      async mergeSubjects(input) {
        const result = await json<{ survivor: string; redirected: string }>(
          await write(world, 'steward', 'POST', '/v1/subjects:merge', { subjects: [input.into, input.from] }),
        );
        if (result.survivor !== input.into || result.redirected !== input.from)
          throw new Error('Native semantic merge did not select the requested survivor');
      },
      async redeliver() {
        return unavailable('production subject.revised event redelivery binding');
      },
      setGate: (gate, open) => setGate(world, gate, open),
      request: world.native.request,
      async inspect(): Promise<ShelvesInspection> {
        type Entry = Omit<StoredEntry, 'sourceStamp'> & {
          sourcePartition: number | null;
          sourceEpoch: number | null;
          sourcePosition: string | null;
        };
        const stored = (
          await database.query<Entry>(
            `SELECT e.account_id AS "accountId",e.subject_id AS "subjectId",e.incarnation_id AS "incarnationId",
          e.state,e.revision,${timestamp('e.created_at')} AS "createdAt",${timestamp('e.updated_at')} AS "updatedAt",
          ${timestamp('e.activity_at')} AS "activityAt",${timestamp('e.finished_at')} AS "finishedAt", e.type_id AS "typeId",
          v.full_type AS "subjectType",e.type_source_id AS "typeSourceId",e.transaction_id AS "transactionId",
          e.type_source_partition AS "sourcePartition",e.type_source_epoch AS "sourceEpoch",e.type_source_position::text AS "sourcePosition"
          FROM library.entry e LEFT JOIN library.shelf_type_value v ON v.route=e.route AND v.account_id=e.account_id AND v.type_id=e.type_id
          WHERE e.account_id=ANY($1::uuid[]) ORDER BY e.route,e.account_id,e.subject_id`,
            [accounts],
          )
        ).rows;
        const entries = stored.map(({ sourcePartition, sourceEpoch, sourcePosition, ...row }): StoredEntry => {
          if (
            sourcePartition === null ||
            sourceEpoch === null ||
            sourcePosition === null ||
            row.incarnationId === null ||
            row.subjectType === null ||
            row.activityAt === null
          )
            return unavailable('native shelf writer/type observation has not populated this entry');
          const sourceStamp: SourceStamp = {
            partition: sourcePartition,
            epoch: sourceEpoch,
            position: BigInt(sourcePosition),
          };
          return { ...row, sourceStamp };
        });
        const typeKeys = (
          await database.query<ShelvesInspection['typeKeys'][number]>(
            `SELECT account_id AS "accountId",type_id AS "typeId",full_type AS type,
          byte_length::integer AS "byteLength" FROM library.shelf_type_value WHERE account_id=ANY($1::uuid[]) ORDER BY route,account_id,type_id`,
            [accounts],
          )
        ).rows;
        const sessions = (
          await database.query<ShelvesInspection['sessions'][number]>(
            `SELECT account_id AS "accountId",session_id AS id,subject_id AS "subjectId",
          version_subject_id AS "versionSubjectId",mode,unit,total::text,amount::text,locator,position::text,completed_unit_count AS "completedUnitCount",state,revision,
          ${timestamp('started_at')} AS "startedAt",${timestamp('completed_at')} AS "completedAt",${timestamp('last_changed_at')} AS "lastChangedAt"
          FROM library.progress_session WHERE account_id=ANY($1::uuid[]) ORDER BY route,account_id,session_id`,
            [accounts],
          )
        ).rows;
        const ids = sessions.map((session) => session.id);
        const completedUnits = (
          await database.query<ShelvesInspection['completedUnits'][number]>(
            `SELECT session_id AS "sessionId",unit_id AS "unitId"
          FROM library.progress_unit WHERE session_id=ANY($1::uuid[]) ORDER BY route,session_id,unit_id`,
            [ids],
          )
        ).rows;
        const changes = (
          await database.query<ShelvesInspection['changes'][number]>(
            `SELECT session_id AS "sessionId",change_no AS revision
          FROM library.progress_change WHERE session_id=ANY($1::uuid[]) ORDER BY route,session_id,change_no`,
            [ids],
          )
        ).rows;
        const heads = (
          await database.query<ShelvesInspection['heads'][number]>(
            `SELECT account_id AS "accountId",subject_id AS "subjectId",
          ${timestamp('last_changed_at')} AS "lastChangedAt",${timestamp('last_completed_at')} AS "lastCompletedAt"
          FROM library.progress_head WHERE account_id=ANY($1::uuid[]) ORDER BY route,account_id,subject_id`,
            [accounts],
          )
        ).rows;
        const counts = (
          await database.query<ShelvesInspection['counts'][number]>(
            `SELECT account_id AS "accountId",bucket,type_id AS "typeId",n::integer AS count
          FROM library.shelf_count WHERE account_id=ANY($1::uuid[]) ORDER BY route,account_id,bucket,type_id`,
            [accounts],
          )
        ).rows;
        const collections = (
          await database.query<ShelvesInspection['collections'][number]>(
            `SELECT curator_account_id AS "accountId",collection_id AS "collectionId"
          FROM library.collection WHERE curator_account_id=ANY($1::uuid[]) AND state='active' ORDER BY route,collection_id`,
            [accounts],
          )
        ).rows;
        const events = (
          await database.query<ShelvesInspection['events'][number]>(
            'SELECT id,type,data FROM core.outbox ORDER BY partition_no,position,event_seq',
          )
        ).rows;
        return { entries, typeKeys, sessions, completedUnits, changes, heads, counts, collections, events };
      },
      async settle() {
        await world.settle();
      },
      async seed(input) {
        await growth.seed(input);
      },
      async measure(operation) {
        const measured = await world.native.capture(operation);
        const cost = costOf(measured.capture);
        return { value: measured.value, statements: cost.statements, rows: cost.rows, buffers: cost.blocks };
      },
      close: world.close,
    };
    return driver;
  } catch (error) {
    await world.close();
    throw error;
  }
}
