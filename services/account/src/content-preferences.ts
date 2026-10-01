import { randomUUID } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { accountResponses, contentPreferencesView } from './views.ts';
import { marketRule } from './market-policy.ts';

export type AgeBand = 'unknown' | 'under-15' | '15-17' | 'adult';
export type Categories = { general: boolean; r15: boolean; r18: boolean; r18g: boolean };
export interface ContentPreferences {
  revision: number; birthDate: string | null; country: string | null;
  birthdayPublic: boolean; publicId: string | null;
  age: AgeBand; accountEligible: boolean; adultAvailable: boolean;
  categories: Categories;
}
type Row = { revision: string; birth_date: string | null; country: string | null;
  birthday_public: boolean; public_id: string | null; general: boolean;
  r15: boolean | null; r18: boolean; r18g: boolean };
type Database = Pick<Pool | PoolClient, 'query'>;
export interface PreferenceChange {
  expectedRevision: number; birthDate?: string | null; country?: string;
  birthdayPublic?: boolean; categories?: Partial<Categories>;
}

/** A civil date, never a timestamp. Feb 29 birthdays reach a threshold on March 1
 * in non-leap years; UTC is the shared boundary used by all Account clients. */
export function ageAt(value: string, now = new Date()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AccountProblem('invalid_birth_date', 400);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const today = now.toISOString().slice(0, 10);
  if (year < 1900 || date.toISOString().slice(0, 10) !== value || value > today)
    throw new AccountProblem('invalid_birth_date', 400);
  const years = now.getUTCFullYear() - year;
  const anniversary = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day)).toISOString().slice(0, 10);
  return years - (today < anniversary ? 1 : 0);
}

function preferences(row?: Row, now = new Date()): ContentPreferences {
  const years = row?.birth_date ? ageAt(row.birth_date, now) : null;
  const rule = marketRule(row?.country);
  const accountEligible = rule.registration && (years === null || years >= rule.minimumAge);
  const age: AgeBand = years === null ? 'unknown' : years < 15 ? 'under-15' : years < 18 ? '15-17' : 'adult';
  return { revision: Number(row?.revision ?? 0), birthDate: row?.birth_date ?? null,
    country: row?.country ?? null, birthdayPublic: row?.birthday_public ?? false,
    publicId: row?.birthday_public ? row.public_id : null, age, accountEligible,
    adultAvailable: rule.adultAvailable,
    categories: { general: row?.general ?? true,
      r15: row?.r15 ?? (years !== null && years >= 15 && accountEligible),
      r18: row?.r18 ?? false, r18g: row?.r18g ?? false } };
}

const select = `SELECT revision, birth_date::text, country, birthday_public, public_id,
  general, r15, r18, r18g FROM rezics_content_preferences WHERE user_id = $1`;
export async function readContentPreferences(db: Database, userId: string, now = new Date()) {
  return preferences((await db.query<Row>(select, [userId])).rows[0], now);
}

/** Serializes even the first write on the existing user key. Omitted preferences
 * retain intent, and nullable R15 means use the age-dependent default. */
export async function writeContentPreferences(pool: Pool, userId: string, input: PreferenceChange,
  requestCountry: string | null, now = new Date()): Promise<ContentPreferences> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    if (!(await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [userId])).rowCount)
      throw new AccountProblem('unauthenticated', 401);
    const prior = (await client.query<Row>(select, [userId])).rows[0];
    if (Number(prior?.revision ?? 0) !== input.expectedRevision) throw new AccountProblem('conflict', 409);
    const birth = input.birthDate === undefined ? prior?.birth_date ?? null : input.birthDate;
    const country = requestCountry ?? input.country ?? prior?.country ?? null;
    if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new AccountProblem('invalid_request', 400);
    const rule = marketRule(country);
    if (!rule.registration) throw new AccountProblem('market_unavailable', 403);
    const years = birth === null ? null : ageAt(birth, now);
    const adultAvailable = rule.adultAvailable;
    const categories = { general: prior?.general ?? true, r15: prior?.r15 ?? null,
      r18: prior?.r18 ?? false, r18g: prior?.r18g ?? false, ...input.categories };
    const belowMinimum = years !== null && years < rule.minimumAge;
    for (const category of ['r15', 'r18', 'r18g'] as const) {
      if (input.categories?.[category] !== true) continue;
      if (belowMinimum) {
        if (category === 'r15') categories.r15 = prior?.r15 ?? null;
        else categories[category] = prior?.[category] ?? false;
        continue;
      }
      if (years === null) throw new AccountProblem('birth_date_required', 400);
      if (years < (category === 'r15' ? 15 : 18)) throw new AccountProblem('age_ineligible', 403);
      if (category !== 'r15' && !adultAvailable) throw new AccountProblem('market_restricted', 403);
    }
    const publish = birth !== null && (input.birthdayPublic ?? prior?.birthday_public ?? false);
    if (input.birthdayPublic && birth === null) throw new AccountProblem('birth_date_required', 400);
    const publicId = publish ? prior?.public_id ?? randomUUID() : null;
    await client.query(`INSERT INTO rezics_content_preferences
      (user_id, revision, birth_date, country, birthday_public, public_id, general, r15, r18, r18g)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id) DO UPDATE SET revision = EXCLUDED.revision,
      birth_date = EXCLUDED.birth_date, country = EXCLUDED.country,
      birthday_public = EXCLUDED.birthday_public, public_id = EXCLUDED.public_id,
      general = EXCLUDED.general, r15 = EXCLUDED.r15, r18 = EXCLUDED.r18, r18g = EXCLUDED.r18g`,
    [userId, input.expectedRevision + 1, birth, country, publish, publicId,
      categories.general, categories.r15, categories.r18, categories.r18g]);
    // An age learned after registration must also enforce account admission.
    // The hold and session revocation commit atomically with the private date.
    if (belowMinimum) {
      await client.query(`UPDATE rezics_account_security SET generation = generation + 1,
        suspended_at = now(), suspended_until = NULL, suspension_reason = 'Account minimum age',
        suspension_code = 'age_requirement' WHERE user_id = $1`, [userId]);
      await client.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
    }
    const saved = await readContentPreferences(client, userId, now);
    await client.query('COMMIT');
    return saved;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

const categoriesSchema = t.Object({ general: t.Boolean(), r15: t.Boolean(), r18: t.Boolean(), r18g: t.Boolean() });
const view = contentPreferencesView;
export function contentPreferencesApi(auth: AccountAuth, pool: Pool) {
  return new Elysia()
    .get('/api/account/content-preferences', { response: accountResponses(view) }, async ({ request }) => {
      try { return accountJson(await readContentPreferences(pool, (await accountSession(auth, request)).user.id)); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/content-preferences', { body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }),
      birthDate: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
      country: t.Optional(t.String({ pattern: '^[A-Z]{2}$' })), birthdayPublic: t.Optional(t.Boolean()),
      categories: t.Optional(t.Partial(categoriesSchema)) }, { additionalProperties: false }),
    response: accountResponses(view) }, async ({ request, body }) => {
      try { return accountJson(await writeContentPreferences(pool, (await accountSession(auth, request)).user.id,
        body, request.headers.get('x-rezics-request-country'))); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/birthday/:id', { params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: accountResponses(t.Object({ birthDate: t.String() })) }, async ({ params }) => {
      try {
        const row = (await pool.query<{ birth_date: string }>(`SELECT p.birth_date::text
          FROM rezics_content_preferences p JOIN "user" u ON u.id = p.user_id
          JOIN rezics_account_security s ON s.user_id = u.id
          WHERE p.public_id = $1 AND p.birthday_public AND p.birth_date IS NOT NULL
            AND s.deletion_started_at IS NULL
            AND (s.suspended_at IS NULL OR s.suspended_until <= now())`, [params.id])).rows[0];
        if (!row) throw new AccountProblem('not_found', 404);
        return accountJson({ birthDate: row.birth_date });
      } catch (error) { return accountFailure(error); }
    });
}
