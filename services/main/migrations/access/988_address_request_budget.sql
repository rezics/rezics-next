-- Preserve every value in 935. Verified readers also consume address capacity;
-- the search family's signed-in exemption must not exempt address resolution.
ALTER TABLE access.rate_limit_v1 DROP CONSTRAINT rate_limit_v1_family_check;
ALTER TABLE access.rate_limit_v1 ADD CONSTRAINT rate_limit_v1_family_check
 CHECK (family IN ('write','upload','report','correspondence','search','provider','address'));
