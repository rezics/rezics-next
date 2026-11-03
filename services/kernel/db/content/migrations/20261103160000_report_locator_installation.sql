-- migrate:up
-- Freeze report insertion and command positions together. This journal is the
-- finite retained-source cut, not a claim inferred from an empty runtime page.
LOCK TABLE core.partition IN SHARE MODE;
LOCK TABLE content.report IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE content.report_reporter ADD COLUMN created_at timestamptz;
CREATE INDEX report_reporter_received_page ON content.report_reporter
  (route, reporter_account_id, created_at DESC, report_id DESC) WHERE created_at IS NOT NULL;

CREATE TABLE content.report_locator_cut (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  epoch integer NOT NULL CHECK (epoch > 0),
  position bigint NOT NULL CHECK (position >= 0),
  expected bigint NOT NULL CHECK (expected >= 0),
  applied bigint NOT NULL DEFAULT 0 CHECK (applied >= 0 AND applied <= expected),
  notified boolean NOT NULL DEFAULT false,
  CHECK (NOT notified OR applied = expected)
);

CREATE TABLE content.report_locator_pending (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  report_id uuid NOT NULL,
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  PRIMARY KEY (partition_no, report_id),
  CHECK (partition_no = route >> 4),
  CHECK (route = get_byte(uuid_send(report_id), 10) * 256 + get_byte(uuid_send(report_id), 11))
);

INSERT INTO content.report_locator_pending(partition_no, report_id, route)
SELECT route >> 4, report_id, route FROM content.report WHERE reporter_account_id IS NOT NULL;

INSERT INTO content.report_locator_cut(partition_no, epoch, position, expected, notified)
SELECT p.partition_no, p.epoch, p.position, count(j.report_id), count(j.report_id) = 0
FROM core.partition p LEFT JOIN content.report_locator_pending j ON j.partition_no = p.partition_no
GROUP BY p.partition_no, p.epoch, p.position;

-- These receiving records all belong to control partition zero. No source
-- installation command writes a foreign partition.
CREATE TABLE content.report_locator_coverage (
  route integer PRIMARY KEY CHECK (route = 0),
  expected integer NOT NULL CHECK (expected BETWEEN 1 AND 4096),
  installed integer NOT NULL DEFAULT 0 CHECK (installed >= 0 AND installed <= expected)
);
INSERT INTO content.report_locator_coverage(route, expected, installed)
SELECT 0, count(*), count(*) FILTER (WHERE expected=0) FROM content.report_locator_cut;

CREATE TABLE content.report_locator_installed (
  route integer NOT NULL CHECK (route = 0),
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  epoch integer NOT NULL,
  position bigint NOT NULL,
  expected bigint NOT NULL,
  PRIMARY KEY (route, source_partition)
);

-- A zero retained-source count under the same locked cut is already complete;
-- this is counted source evidence, not an empty runtime scan or an install flag.
INSERT INTO content.report_locator_installed(route, source_partition, epoch, position, expected)
SELECT 0, partition_no, epoch, position, expected FROM content.report_locator_cut WHERE expected=0;

-- migrate:down
DROP TABLE content.report_locator_installed;
DROP TABLE content.report_locator_coverage;
DROP TABLE content.report_locator_pending;
DROP TABLE content.report_locator_cut;
DROP INDEX content.report_reporter_received_page;
ALTER TABLE content.report_reporter DROP COLUMN created_at;
