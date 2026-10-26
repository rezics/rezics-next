-- migrate:up
ALTER TABLE access.exposure_opening
  ADD COLUMN route integer NOT NULL DEFAULT 0 CHECK (route = 0),
  DROP CONSTRAINT exposure_opening_pkey;
ALTER TABLE access.exposure_opening
  ADD PRIMARY KEY (route, "group", valid WITHOUT OVERLAPS);

-- migrate:down
ALTER TABLE access.exposure_opening DROP CONSTRAINT exposure_opening_pkey;
ALTER TABLE access.exposure_opening
  ADD PRIMARY KEY ("group", valid WITHOUT OVERLAPS),
  DROP COLUMN route;
