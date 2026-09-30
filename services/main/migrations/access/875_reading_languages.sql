-- Main reading languages have one owner. Home retains presentation preferences
-- and the revision used by its existing CAS/cursor protocol, never languages.
ALTER TABLE access.person_preferences DROP CONSTRAINT person_preferences_content_languages_check;
ALTER TABLE access.person_preferences ADD CONSTRAINT person_preferences_content_languages_check
  CHECK (cardinality(content_languages) <= 20);

-- One-use normalization for the legacy two/three-letter language-tag stores.
-- New commands use the shared Intl-backed canonicalLanguage contract.
CREATE FUNCTION pg_temp.reading_language(tag text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE parts text[] := string_to_array(lower(tag), '-'); result text; part text; extension boolean := false;
  -- Legacy primary-language and territory aliases derived from canonicalLanguage
  -- with the installed ICU. These are migration data, not a second runtime parser.
  aliases constant jsonb := '{"aam":"aas","aar":"aa","abk":"ab","adp":"dz","afr":"af","aka":"ak","amh":"am","ara":"ar","arg":"an","asm":"as","aue":"ktz","ava":"av","ave":"ae","aym":"ay","ayx":"nun","aze":"az","bak":"ba","bam":"bm","bel":"be","ben":"bn","bgm":"bcg","bis":"bi","bjd":"drl","bod":"bo","bos":"bs","bre":"br","bul":"bg","cat":"ca","ccq":"rki","ces":"cs","cha":"ch","che":"ce","chu":"cu","chv":"cv","cjr":"mom","cka":"cmr","cmk":"xch","cor":"kw","cos":"co","coy":"pij","cqu":"quh","cre":"cr","cym":"cy","dan":"da","deu":"de","div":"dv","drh":"khk","drw":"prs","dzo":"dz","ell":"el","eng":"en","epo":"eo","est":"et","eus":"eu","ewe":"ee","fao":"fo","fas":"fa","fij":"fj","fin":"fi","fra":"fr","fry":"fy","ful":"ff","gav":"dev","gfx":"vaj","ggn":"gvr","gla":"gd","gle":"ga","glg":"gl","glv":"gv","grn":"gn","gti":"nyc","guj":"gu","guv":"duz","hat":"ht","hau":"ha","heb":"he","her":"hz","hin":"hi","hmo":"ho","hrr":"jal","hrv":"hr","hun":"hu","hye":"hy","ibi":"opa","ibo":"ig","ido":"io","iii":"ii","iku":"iu","ile":"ie","ilw":"gal","in":"id","ina":"ia","ind":"id","ipk":"ik","isl":"is","ita":"it","iw":"he","jav":"jv","jaw":"jv","jeg":"oyb","ji":"yi","jpn":"ja","jw":"jv","kal":"kl","kan":"kn","kas":"ks","kat":"ka","kau":"kr","kaz":"kk","kgc":"tdf","kgh":"kml","khm":"km","kik":"ki","kin":"rw","kir":"ky","koj":"kwv","kom":"kv","kon":"kg","kor":"ko","krm":"bmf","ktr":"dtp","kua":"kj","kur":"ku","kvs":"gdj","kwq":"yam","kxe":"tvd","kzj":"dtp","kzt":"dtp","lao":"lo","lat":"la","lav":"lv","lii":"raq","lim":"li","lin":"ln","lit":"lt","lmm":"rmx","ltz":"lb","lub":"lu","lug":"lg","mah":"mh","mal":"ml","mar":"mr","meg":"cir","mkd":"mk","mlg":"mg","mlt":"mt","mo":"ro","mol":"ro","mon":"mn","mri":"mi","msa":"ms","mst":"mry","mwj":"vaj","mya":"my","myt":"mry","nad":"xny","nau":"na","nav":"nv","nbl":"nr","ncp":"kdz","nde":"nd","ndo":"ng","nep":"ne","nld":"nl","nno":"nn","nnx":"ngv","nob":"nb","nor":"no","nts":"pij","nya":"ny","oci":"oc","oji":"oj","ori":"or","orm":"om","oss":"os","oun":"vaj","pan":"pa","pcr":"adx","pli":"pi","pmc":"huw","pmu":"phr","pol":"pl","por":"pt","ppa":"bfy","ppr":"lcq","pry":"prt","pus":"ps","puz":"pub","que":"qu","roh":"rm","ron":"ro","run":"rn","rus":"ru","sag":"sg","san":"sa","sca":"hle","sin":"si","skk":"oyb","slk":"sk","slv":"sl","sme":"se","smo":"sm","sna":"sn","snd":"sd","som":"so","sot":"st","spa":"es","sqi":"sq","srd":"sc","srp":"sr","ssw":"ss","sun":"su","swa":"sw","swe":"sv","tah":"ty","tam":"ta","tat":"tt","tdu":"dtp","tel":"te","tgk":"tg","tgl":"tl","tha":"th","thc":"tpo","thx":"oyb","tie":"ras","tir":"ti","tkk":"twm","tlw":"weo","tmp":"tyj","tne":"kak","tnf":"prs","ton":"to","tsf":"taj","tsn":"tn","tso":"ts","tuk":"tk","tur":"tr","twi":"tw","uig":"ug","ukr":"uk","uok":"ema","urd":"ur","uzb":"uz","ven":"ve","vie":"vi","vol":"vo","wln":"wa","wol":"wo","xba":"cax","xho":"xh","xia":"acn","xkh":"waw","xsj":"suj","ybd":"rki","yid":"yi","yma":"lrr","ymt":"mtm","yor":"yo","yos":"zom","yuu":"yug","zha":"za","zho":"zh","zul":"zu"}';
  regions constant jsonb := '{"bu":"MM","dd":"DE","fx":"FR","tp":"TL","yd":"YE","zr":"CD"}';
BEGIN
  result := coalesce(aliases->>parts[1], parts[1]);
  FOREACH part IN ARRAY parts[2:cardinality(parts)] LOOP
    IF length(part) = 1 THEN extension := true; END IF;
    result := result || '-' || CASE
      WHEN NOT extension AND part ~ '^[a-z]{4}$' THEN initcap(part)
      WHEN NOT extension AND part ~ '^[a-z]{2}$' THEN coalesce(regions->>part, upper(part))
      ELSE part END;
  END LOOP;
  RETURN result;
END $$;

-- Home belonged to the principal; settings belong to its first Person Agent,
-- the same stable first-sign-in identity onboarding selects. A missing binding
-- aborts instead of discarding an old reader's saved languages.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM access.home_state h
    WHERE jsonb_array_length(coalesce(h.preferences->'contentLanguages', '[]')) > 0
      AND NOT EXISTS (SELECT 1 FROM access.agent_provision a
        WHERE a.principal_id = h.principal_id AND a.agent_kind = 'person')) THEN
    RAISE EXCEPTION 'Reading languages have no Person Agent binding';
  END IF;
END $$;

WITH first_person AS (
  SELECT DISTINCT ON (principal_id) principal_id, agent_id
  FROM access.agent_provision WHERE agent_kind = 'person'
  ORDER BY principal_id, (state = 'active') DESC, created_at, id
), agents AS (
  SELECT agent_id FROM access.person_preferences
  UNION
  SELECT a.agent_id FROM access.home_state h JOIN first_person a USING (principal_id)
), combined AS (
  SELECT a.agent_id, coalesce(p.content_languages, '{}') || ARRAY(
    SELECT jsonb_array_elements_text(coalesce(h.preferences->'contentLanguages', '[]'))
  ) AS languages
  FROM agents a LEFT JOIN access.person_preferences p USING (agent_id)
  LEFT JOIN first_person f USING (agent_id)
  LEFT JOIN access.home_state h USING (principal_id)
), merged AS (
  SELECT agent_id, ARRAY(
    SELECT canonical FROM (
      SELECT pg_temp.reading_language(tag) AS canonical, min(position) AS first_position
      FROM unnest(languages) WITH ORDINALITY t(tag, position)
      GROUP BY pg_temp.reading_language(tag)
    ) ordered ORDER BY first_position
  ) AS languages FROM combined
)
INSERT INTO access.person_preferences (agent_id, content_languages, version)
SELECT agent_id, languages, 1 FROM merged
ON CONFLICT (agent_id) DO UPDATE SET content_languages = EXCLUDED.content_languages,
  version = access.person_preferences.version + 1, updated_at = clock_timestamp();

UPDATE access.home_state SET preferences = preferences - 'contentLanguages', revision = gen_random_uuid();
ALTER TABLE access.home_state ALTER COLUMN preferences SET DEFAULT
  '{"tab":"following","sort":"best","density":"card","recommendations":true}'::jsonb;
ALTER TABLE access.home_state ADD CONSTRAINT home_state_no_reading_languages
  CHECK (NOT preferences ? 'contentLanguages');
