package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class TitleControlPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String HEAD = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String NEXT = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String CONTROL = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String RECEIPT = "urn:rezics:receipt:title-language-test";
    private static final byte[] KEY = new byte[32];
    private static String iri(String value) { return "<" + value + ">"; }

    private static String exercise(String language, String declared, String stored, boolean legacy) throws Exception {
        return exercise(language, declared, stored, legacy, false, false);
    }

    private static String exercise(String language, String declared, String stored, boolean legacy,
                                   boolean stale, boolean unsigned) throws Exception {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        boolean committed = false;
        try {
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI("https://schema.org/CreativeWork"));
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                NodeFactory.createURI(RV + "head"), NodeFactory.createURI(stale ? NEXT : HEAD));
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label"), NodeFactory.createLiteralLang("original", language));
            JsonObject intent = new JsonObject();
            intent.put("work", WORK); intent.put("expectedHead", HEAD); intent.put("action", "work.edit");
            intent.put("title", "新しい名前"); intent.put("source", org.apache.jena.atlas.json.JsonNull.instance);
            if (declared != null) intent.put("language", declared);
            JsonObject basis = new JsonObject(); basis.put("epoch", "0");
            basis.put("head", org.apache.jena.atlas.json.JsonNull.instance);
            basis.put("protection", org.apache.jena.atlas.json.JsonNull.instance); intent.put("basis", basis);
            String jsonLiteral = org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString(intent.toString()));
            String update = "PREFIX rv: <" + RV + "> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> "
                + "DELETE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK) + " rv:head " + iri(HEAD) + "; rdfs:label ?old } } "
                + "INSERT { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK) + " rv:head " + iri(NEXT)
                + "; rdfs:label \"新しい名前\"@" + stored + "; rv:titleControlHead " + iri(CONTROL) + " } "
                + "GRAPH " + iri(CommandPolicy.REVISIONS) + " { " + iri(CONTROL)
                + " a rv:RevisionAnchor, rv:EditorialControlRevision; rv:component " + iri(WORK)
                + "; rv:workRevision " + iri(NEXT) + "; rv:controlMode rv:HumanControlled; rv:controlEpoch 1; rv:controlField \""
                + (legacy ? "title:en" : "title") + "\"; "
                + (legacy ? "" : "rv:controlLanguage \"" + (declared == null ? language : declared) + "\"; ")
                + "rv:controlIntent " + jsonLiteral + "; rv:operation <urn:rezics:operation:title-language>; "
                + "rv:manifest <urn:rezics:sha256:title-language>; rv:modelRevision "
                + iri("https://rezics.com/definition/work-title-control-" + (legacy ? "v1" : "v2"))
                + "; rv:shapeRevision " + iri("https://rezics.com/definition/work-title-control-" + (legacy ? "v1" : "v2"))
                + "; rv:dataEpoch \"epoch\"; rv:sequence 1 . " + iri(NEXT) + " a rv:RevisionAnchor; rv:component " + iri(WORK) + " } "
                + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
                + " rv:outcome rv:Succeeded; rv:work " + iri(WORK) + "; rv:expectedHead " + iri(HEAD)
                + "; rv:expectedControl rv:Absent; rv:expectedProtection rv:Absent; rv:expectedControlEpoch 0; rv:titleControl " + iri(CONTROL)
                + "; rv:workRevision " + iri(NEXT) + "; rv:admissionId \"admission\"; rv:action \"work.edit\"; rv:authorityEpoch \"1\"; rv:admittedScope \"work:edit:" + WORK + "\" } } "
                + "WHERE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK) + " rdfs:label ?old } }";
            JsonArray claims = new JsonArray();
            for (String claim : new String[] { "rezics-work-title-admission-v1", "admission", "work.edit", "work:edit:" + WORK,
                "1", RECEIPT, "digest", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(update.getBytes(StandardCharsets.UTF_8))),
                Instant.now().plusSeconds(60).toString() }) claims.add(claim);
            String payload = claims.toString(); Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(KEY, "HmacSHA256"));
            JsonObject proof = new JsonObject(); proof.put("payload", payload);
            proof.put("signature", HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8))));
            var snapshot = TitleControlPolicy.capture(data, CommandPolicy.parse(update, RECEIPT), RECEIPT, "digest", update, unsigned ? null : proof, KEY, false);
            if (snapshot.error() != null) return snapshot.error();
            UpdateAction.parseExecute(update, DatasetFactory.wrap(data));
            String error = TitleControlPolicy.check(data, RECEIPT, snapshot);
            if (error != null) return error;
            // This is the canonical validation used by CommandService.validateScope,
            // with the real generated manifest, not request-selected focus or a mock.
            ProfileRegistry profiles = ProfileRegistry.load(Files.isDirectory(Path.of("profiles"))
                ? Path.of("profiles") : Path.of("../../../generated/model"));
            assertEquals("work-title-control-" + (legacy ? "v1" : "v2"),
                CanonicalPolicy.select(profiles, data, CONTROL, true).route().profile());
            var canonical = CanonicalPolicy.validate(profiles, data, CONTROL, true);
            if (canonical != null) return String.valueOf(canonical.get("report"));
            data.commit();
            committed = true;
            return null;
        } finally { if (!committed) data.abort(); data.end(); data.close(); }
    }

    @Test public void g512DeclaredAndOmittedLanguagesSurviveTheSignedCommand() throws Exception {
        for (String language : new String[] { "ja", "zh-Hant", "und", "ar" }) {
            assertNull(exercise("en", language, language, false));
            assertNull(exercise(language, null, language, false));
            assertEquals("title value differs from intent", exercise(language, null, "en", false));
        }
        assertNull(exercise("en", null, "en", true));
    }

    @Test public void g512LanguageValidationIsNotAnEnglishLocaleEnum() {
        for (String language : new String[] { "ja", "zh-Hant", "ar", "und", "en-US", "de-u-co-phonebk" })
            assertTrue(TitleControlPolicy.validLanguage(language));
        for (String language : new String[] { "", "Japanese", "ja_en", "ja--JP", "ja-12", "ja\"; DROP" })
            assertFalse(TitleControlPolicy.validLanguage(language));
    }
    @Test public void g512LanguageDoesNotWeakenTheStaleOrDeniedGuards() throws Exception {
        assertEquals("title transaction basis changed", exercise("ja", "zh-Hant", "zh-Hant", false, true, false));
        assertEquals("trusted title admission required", exercise("ja", "zh-Hant", "zh-Hant", false, false, true));
        assertEquals("invalid title language", exercise("ja", "ja-12", "ja", false));
        assertEquals("title value differs from intent", exercise("en", "zh-Hant", "en", false));
    }

}
