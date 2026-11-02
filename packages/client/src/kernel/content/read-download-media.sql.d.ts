import type { Query } from "reylo";
export type Params = {
    route: number;
    media_id: string;
    format: string;
    width: number;
};
export type Row = {
    media_id: string;
    container_id: string;
    claimed_item_id: string | null;
    uploader_id: string;
    purpose: "post-image" | "cover" | "avatar" | "realm-icon" | "realm-banner";
    state: "reserved" | "uploaded" | "available" | "rejected";
    claimed_at: string | null;
    key: string;
    sha256: string | null;
    media_type: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | null;
    actual_byte_count: bigint | null;
    erased: boolean;
    collection_pending: boolean;
    taken_down: boolean;
    security_revision: string;
    provenance: unknown | null;
    width: number | null;
    height: number | null;
    thumbhash: string | null;
    average_color: string | null;
    focal_x: number | null;
    focal_y: number | null;
    credit: unknown | null;
    variant_key: string | null;
    variant_sha256: string | null;
    variant_media_type: string | null;
    variant_byte_count: bigint | null;
    variant_format: "avif" | "webp" | null;
    variant_width: number | null;
    variant_height: number | null;
};
export type QueryError = import("reylo").QueryError<"postgres">;
/**
 * No variant enumeration: this is one exact object and one exact processed slot.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT $1::integer AS route, $2::uuid AS media_id,
 *          $3::text AS format, $4::integer AS width
 * )
 * SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
 *        m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
 *        m.taken_down, m.security_revision::text, m.provenance,
 *        COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
 *        encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
 *        v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
 *        v.byte_count AS variant_byte_count, v.format AS variant_format,
 *        v.width AS variant_width, v.height AS variant_height
 * FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
 * LEFT JOIN content.media_variant v
 *   ON v.route = i.route AND v.media_id = m.media_id
 *   AND v.format = i.format AND v.width = i.width;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "-- No variant enumeration: this is one exact object and one exact processed slot.\nWITH input AS NOT MATERIALIZED (\n  SELECT $1::integer AS route, $2::uuid AS media_id,\n         $3::text AS format, $4::integer AS width\n)\nSELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,\n       m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,\n       m.taken_down, m.security_revision::text, m.provenance,\n       COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,\n       encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,\n       v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,\n       v.byte_count AS variant_byte_count, v.format AS variant_format,\n       v.width AS variant_width, v.height AS variant_height\nFROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id\nLEFT JOIN content.media_variant v\n  ON v.route = i.route AND v.media_id = m.media_id\n  AND v.format = i.format AND v.width = i.width /*file='src%2Fcontent%2Fread-download-media.sql'*/;";
/**
 * No variant enumeration: this is one exact object and one exact processed slot.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route, :media_id::uuid AS media_id,
 *          :format::text AS format, :width::integer AS width
 * )
 * SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
 *        m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
 *        m.taken_down, m.security_revision::text, m.provenance,
 *        COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
 *        encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
 *        v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
 *        v.byte_count AS variant_byte_count, v.format AS variant_format,
 *        v.width AS variant_width, v.height AS variant_height
 * FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
 * LEFT JOIN content.media_variant v
 *   ON v.route = i.route AND v.media_id = m.media_id
 *   AND v.format = i.format AND v.width = i.width;
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "-- No variant enumeration: this is one exact object and one exact processed slot.\nWITH input AS NOT MATERIALIZED (\n  SELECT :route::integer AS route, :media_id::uuid AS media_id,\n         :format::text AS format, :width::integer AS width\n)\nSELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,\n       m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,\n       m.taken_down, m.security_revision::text, m.provenance,\n       COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,\n       encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,\n       v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,\n       v.byte_count AS variant_byte_count, v.format AS variant_format,\n       v.width AS variant_width, v.height AS variant_height\nFROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id\nLEFT JOIN content.media_variant v\n  ON v.route = i.route AND v.media_id = m.media_id\n  AND v.format = i.format AND v.width = i.width;\n";
export declare const params: readonly ["route", "media_id", "format", "width"];
/**
 * No variant enumeration: this is one exact object and one exact processed slot.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route, :media_id::uuid AS media_id,
 *          :format::text AS format, :width::integer AS width
 * )
 * SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
 *        m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
 *        m.taken_down, m.security_revision::text, m.provenance,
 *        COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
 *        encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
 *        v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
 *        v.byte_count AS variant_byte_count, v.format AS variant_format,
 *        v.width AS variant_width, v.height AS variant_height
 * FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
 * LEFT JOIN content.media_variant v
 *   ON v.route = i.route AND v.media_id = m.media_id
 *   AND v.format = i.format AND v.width = i.width;
 * ```
 */
declare const query: Query<{
    route: number;
    media_id: string;
    format: string;
    width: number;
}, {
    media_id: string;
    container_id: string;
    claimed_item_id: string | null;
    uploader_id: string;
    purpose: "post-image" | "cover" | "avatar" | "realm-icon" | "realm-banner";
    state: "reserved" | "uploaded" | "available" | "rejected";
    claimed_at: string | null;
    key: string;
    sha256: string | null;
    media_type: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | null;
    actual_byte_count: bigint | null;
    erased: boolean;
    collection_pending: boolean;
    taken_down: boolean;
    security_revision: string;
    provenance: unknown | null;
    width: number | null;
    height: number | null;
    thumbhash: string | null;
    average_color: string | null;
    focal_x: number | null;
    focal_y: number | null;
    credit: unknown | null;
    variant_key: string | null;
    variant_sha256: string | null;
    variant_media_type: string | null;
    variant_byte_count: bigint | null;
    variant_format: "avif" | "webp" | null;
    variant_width: number | null;
    variant_height: number | null;
}, "maybeOne", "postgres", QueryError> & {
    /**
     * No variant enumeration: this is one exact object and one exact processed slot.
     *
     * ```sql
     * WITH input AS NOT MATERIALIZED (
     *   SELECT $1::integer AS route, $2::uuid AS media_id,
     *          $3::text AS format, $4::integer AS width
     * )
     * SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
     *        m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
     *        m.taken_down, m.security_revision::text, m.provenance,
     *        COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
     *        encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
     *        v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
     *        v.byte_count AS variant_byte_count, v.format AS variant_format,
     *        v.width AS variant_width, v.height AS variant_height
     * FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
     * LEFT JOIN content.media_variant v
     *   ON v.route = i.route AND v.media_id = m.media_id
     *   AND v.format = i.format AND v.width = i.width;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * No variant enumeration: this is one exact object and one exact processed slot.
     *
     * ```sql
     * WITH input AS NOT MATERIALIZED (
     *   SELECT :route::integer AS route, :media_id::uuid AS media_id,
     *          :format::text AS format, :width::integer AS width
     * )
     * SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
     *        m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
     *        m.taken_down, m.security_revision::text, m.provenance,
     *        COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
     *        encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
     *        v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
     *        v.byte_count AS variant_byte_count, v.format AS variant_format,
     *        v.width AS variant_width, v.height AS variant_height
     * FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
     * LEFT JOIN content.media_variant v
     *   ON v.route = i.route AND v.media_id = m.media_id
     *   AND v.format = i.format AND v.width = i.width;
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
