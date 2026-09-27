import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

export interface ReadingSettings {
  fontSize: 15 | 17 | 19 | 22 | 25;
  lineWidth: 'narrow' | 'medium' | 'wide';
  typeface: 'serif' | 'sans';
  paragraphIndent: boolean;
  theme: 'system' | 'light' | 'dark';
  cjkSpacing: 'auto' | 'none';
  cjkPunctuation: 'standard' | 'strict';
}
export interface ReadingSettingsResult extends ReadingSettings {
  profile: 'reader-settings-v1';
  version: number;
  replayed?: boolean;
}

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  fontSize: 17, lineWidth: 'medium', typeface: 'serif', paragraphIndent: false,
  theme: 'system', cjkSpacing: 'auto', cjkPunctuation: 'standard',
};
export const READING_SETTINGS_COST = { readStatements: 1, writeStatements: 9 } as const;

export class InvalidReadingSettings extends Error {}
export class StaleReadingSettings extends Error {}
export class ReadingSettingsConflict extends Error {}

interface Row {
  font_size: ReadingSettings['fontSize']; line_width: ReadingSettings['lineWidth'];
  typeface: ReadingSettings['typeface']; paragraph_indent: boolean;
  theme: ReadingSettings['theme']; cjk_spacing: ReadingSettings['cjkSpacing'];
  cjk_punctuation: ReadingSettings['cjkPunctuation']; version: string;
}
const columns = `font_size, line_width, typeface, paragraph_indent, theme,
  cjk_spacing, cjk_punctuation, version::text AS version`;
const result = (row?: Row): ReadingSettingsResult => row ? {
  profile: 'reader-settings-v1', fontSize: row.font_size, lineWidth: row.line_width,
  typeface: row.typeface, paragraphIndent: row.paragraph_indent, theme: row.theme,
  cjkSpacing: row.cjk_spacing, cjkPunctuation: row.cjk_punctuation, version: Number(row.version),
} : { profile: 'reader-settings-v1', ...DEFAULT_READING_SETTINGS, version: 0 };

/** One indexed row read; writes use at most nine statements and serialize only this principal. */
export class ReadingSettingsStore {
  constructor(private readonly pool: Pool) {}

  async read(principal: VerifiedPrincipal): Promise<ReadingSettingsResult> {
    const rows = await this.pool.query<Row>(`SELECT ${columns} FROM reader.settings
      WHERE principal_issuer = $1 AND principal_subject = $2`, [principal.issuer, principal.subject]);
    return result(rows.rows[0]);
  }

  async write(principal: VerifiedPrincipal, settings: ReadingSettings, expectedVersion: number,
    idempotencyKey: string): Promise<ReadingSettingsResult> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
      throw new InvalidReadingSettings('invalid reader settings command');
    }
    const digest = createHash('sha256').update(JSON.stringify([settings.fontSize, settings.lineWidth,
      settings.typeface, settings.paragraphIndent, settings.theme, settings.cjkSpacing,
      settings.cjkPunctuation, expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['reading-settings', principal.issuer, principal.subject])]);
      const prior = await client.query<{ request_digest: string; result: ReadingSettingsResult }>(
        `SELECT request_digest, result FROM reader.settings_command
         WHERE principal_issuer = $1 AND principal_subject = $2 AND idempotency_key = $3`,
        [principal.issuer, principal.subject, idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest) {
          throw new ReadingSettingsConflict('idempotency key has another settings intent');
        }
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      const current = await client.query<Row>(`SELECT ${columns} FROM reader.settings
        WHERE principal_issuer = $1 AND principal_subject = $2 FOR UPDATE`,
        [principal.issuer, principal.subject]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== expectedVersion) throw new StaleReadingSettings('reader settings changed');
      const next = version + 1;
      const values = [principal.issuer, principal.subject, settings.fontSize, settings.lineWidth,
        settings.typeface, settings.paragraphIndent, settings.theme, settings.cjkSpacing,
        settings.cjkPunctuation, next];
      if (version === 0) {
        await client.query(`INSERT INTO reader.settings (principal_issuer, principal_subject,
          font_size, line_width, typeface, paragraph_indent, theme, cjk_spacing, cjk_punctuation, version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, values);
      } else {
        await client.query(`UPDATE reader.settings SET font_size = $3, line_width = $4,
          typeface = $5, paragraph_indent = $6, theme = $7, cjk_spacing = $8,
          cjk_punctuation = $9, version = $10, updated_at = clock_timestamp()
          WHERE principal_issuer = $1 AND principal_subject = $2`, values);
      }
      const saved: ReadingSettingsResult = { profile: 'reader-settings-v1', ...settings, version: next };
      await client.query(`INSERT INTO reader.settings_command
        (principal_issuer, principal_subject, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4,$5)`, [principal.issuer, principal.subject, idempotencyKey, digest,
        JSON.stringify(saved)]);
      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new StaleReadingSettings('reader settings changed concurrently');
      }
      throw error;
    } finally { client.release(); }
  }
}
