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
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
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

    private static String hash(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    private static final class CandidateFixture implements AutoCloseable {
        final DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        final String admission = "11111111-1111-4111-8111-111111111111", main = WORK.replace("000001", "000010");
        final String operation = WORK.replace("000001", "000011"), manifest = "urn:rezics:sha256:" + "a".repeat(64);
        final String receipt, digest; final JsonObject frame, candidate, proof;
        CandidateFixture() throws Exception { this(Instant.now().plusSeconds(600)); }
        CandidateFixture(Instant expiry) throws Exception {
            receipt = "urn:rezics:receipt:" + hash(admission + "\0edit-metadata-work");
            digest = hash("{\"profile\":\"work-title-control-v2\",\"work\":\"" + WORK
                + "\",\"expectedHead\":\"" + HEAD + "\",\"basis\":{\"head\":null,\"epoch\":\"0\",\"protection\":null},"
                + "\"action\":\"work.edit\",\"title\":\"A new title\",\"language\":\"zh-Hant\",\"source\":null}");
            frame = JSON.parse("""
                {"format":"rezics-human-title-candidate-frame-v1","receipt":"%s","digest":"%s",
                 "admission":{"id":"%s","action":"work.edit","scope":"work:edit:%s","authorityEpoch":"0","expiresAt":"%s"},
                 "actor":{"principalId":"22222222-2222-4222-8222-222222222222","actingSubject":null},
                 "intent":{"work":"%s","expectedHead":"%s","basis":{"head":null,"epoch":"0","protection":null},
                   "action":"work.edit","title":"A new title","language":"zh-Hant","source":null},
                 "planned":{"revision":"%s","control":"%s","operation":"%s"},
                 "originalManifest":"%s","workManifest":"urn:rezics:sha256:%s","controlManifest":"urn:rezics:sha256:%s",
                 "mainVersion":"%s","dataEpoch":"epoch","routingEpoch":"routing","deadlineMs":10000,"validations":[]}
                """.formatted(receipt, digest, admission, WORK,
                    new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(expiry), WORK, HEAD, NEXT, CONTROL, operation,
                    manifest, "b".repeat(64), "c".repeat(64), main));
            JsonArray validations = new JsonArray();
            String base = "https://rezics.com/definition/";
            for (String[] row : new String[][] {
                {"work-metadata-v1", base + "work-metadata-v1/work-shape", WORK},
                {"work-metadata-v1", base + "work-metadata-v1/main-version-shape", main},
                {"work-title-control-v2", base + "work-title-control-v2/control-shape", CONTROL} }) {
                JsonObject validation = new JsonObject(); validation.put("profile", row[0]); validation.put("sha256", "d".repeat(64));
                validation.put("shape", row[1]); JsonArray focus = new JsonArray(); focus.add(row[2]); validation.put("focus", focus);
                JsonArray graphs = new JsonArray(); graphs.add(CommandPolicy.CURRENT);
                if (row[0].equals("work-title-control-v2")) graphs.add(CommandPolicy.REVISIONS);
                validation.put("graphs", graphs); validation.put("binding", new JsonObject()); validations.add(validation);
            }
            frame.put("validations", validations);
            candidate = new JsonObject(); candidate.put("frame", TitleControlPolicy.canonicalCandidateJSON(frame));
            candidate.put("custodySha256", "e".repeat(64)); candidate.put("mode", "accept");
            proof = sign(frame, candidate);
            write(() -> {
                var current = NodeFactory.createURI(CommandPolicy.CURRENT); var revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
                var controlGraph = NodeFactory.createURI(CommandPolicy.CONTROL); var product = NodeFactory.createURI("urn:rezics:dataset:product");
                data.add(current, NodeFactory.createURI(WORK), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI("https://schema.org/CreativeWork"));
                data.add(current, NodeFactory.createURI(WORK), NodeFactory.createURI(RV + "head"), NodeFactory.createURI(HEAD));
                data.add(current, NodeFactory.createURI(WORK), NodeFactory.createURI(RV + "mainVersion"), NodeFactory.createURI(main));
                data.add(current, NodeFactory.createURI(WORK), org.apache.jena.vocabulary.RDFS.label.asNode(), NodeFactory.createLiteralLang("Old title", "en"));
                data.add(current, NodeFactory.createURI(main), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "MainVersion"));
                data.add(current, NodeFactory.createURI(main), NodeFactory.createURI(RV + "work"), NodeFactory.createURI(WORK));
                data.add(revisions, NodeFactory.createURI(HEAD), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "RevisionAnchor"));
                for (String[] field : new String[][] { {"component", WORK}, {"manifest", manifest},
                    {"modelRevision", base + "work-metadata-v1"}, {"shapeRevision", base + "work-metadata-v1"} })
                    data.add(revisions, NodeFactory.createURI(HEAD), NodeFactory.createURI(RV + field[0]), NodeFactory.createURI(field[1]));
                data.add(controlGraph, product, NodeFactory.createURI(RV + "dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(controlGraph, product, NodeFactory.createURI(RV + "routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(controlGraph, product, NodeFactory.createURI(RV + "textIndexGeneration"), NodeFactory.createURI("urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333"));
                data.add(controlGraph, product, NodeFactory.createURI(RV + "sequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                SearchDeltaJournal.initialize(data); PublicNameProjection.workScopeExclusiveStartup(data); return null;
            });
            write(() -> { assertEquals(0, PublicNameProjection.prepareWorkScopeDirectory(data)); return null; });
        }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T value = operation.get(); data.commit(); return value; }
            catch (RuntimeException | Error error) { data.abort(); throw error; } finally { data.end(); }
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ); try { return operation.get(); } finally { data.end(); }
        }
        Set<Quad> quads() { return read(() -> {
            Set<Quad> quads = new HashSet<>(); var rows = data.find();
            try { rows.forEachRemaining(quads::add); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); } return quads;
        }); }
        PublicNameProjection.WorkNameBasis basis() {
            return read(() -> PublicNameProjection.captureWorkNameBasis(data, NodeFactory.createURI(WORK), Long.MAX_VALUE));
        }
        Map<String, Object> retain(JsonObject candidate, JsonObject proof) {
            return write(() -> TitleControlPolicy.retainCandidate(data, receipt, digest, candidate, proof, KEY, Long.MAX_VALUE));
        }
        void change(Consumer<DatasetGraph> mutation) {
            write(() -> {
                var capture = new SearchDeltaJournal.Capture(data); mutation.accept(capture.observed());
                SearchDeltaJournal.append(data, capture, 2); return null;
            });
        }
        @Override public void close() { data.close(); }
    }
    // These signatures qualify only native validation. They are not SQL actor/custody integration evidence.
    private static JsonObject sign(JsonObject frame, JsonObject candidate) throws Exception {
        var admission = frame.get("admission").getAsObject(); var actor = frame.get("actor").getAsObject();
        JsonArray claims = new JsonArray();
        for (String claim : new String[] {"rezics-human-title-candidate-admission-v1", admission.get("id").getAsString().value(),
            "work.edit", admission.get("scope").getAsString().value(), admission.get("authorityEpoch").getAsString().value(),
            frame.get("receipt").getAsString().value(), frame.get("digest").getAsString().value(),
            hash(candidate.get("frame").getAsString().value()), candidate.get("custodySha256").getAsString().value(),
            actor.get("principalId").getAsString().value()}) claims.add(claim);
        claims.add(actor.get("actingSubject")); claims.add(admission.get("expiresAt"));
        return signClaims(claims);
    }
    private static JsonObject signClaims(JsonArray claims) throws Exception {
        String payload = TitleControlPolicy.canonicalCandidateJSON(claims);
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(KEY, "HmacSHA256"));
        var proof = new JsonObject(); proof.put("payload", payload);
        proof.put("signature", HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)))); return proof;
    }
    private static JsonObject copy(JsonObject object) { return JSON.parse(object.toString()); }

    @Test public void privateNativeTitleAcceptanceRetainsExactProofWithoutChangingSourceOrPublicFacts() throws Exception {
        try (var f = new CandidateFixture()) {
            var before = f.quads(); var basis = f.basis();
            var accepted = f.retain(f.candidate, f.proof); assertEquals(accepted.toString(), "accepted", accepted.get("status"));
            assertEquals(true, accepted.get("changed")); assertEquals(basis, f.basis());
            var after = f.quads(); assertEquals(before.size() + 1, after.size()); assertTrue(after.containsAll(before));
            Set<Quad> inserted = new HashSet<>(after); inserted.removeAll(before);
            assertEquals(PublicNameProjection.REPAIR, inserted.iterator().next().getGraph());
            assertEquals("accepted", f.retain(f.candidate, f.proof).get("status"));
            assertEquals(false, f.retain(f.candidate, f.proof).get("changed")); assertEquals(after, f.quads());
            var lookup = copy(f.candidate); lookup.put("mode", "lookup");
            assertEquals("historical", f.retain(lookup, f.proof).get("status")); assertEquals(after, f.quads());
        }
    }
    @Test public void nativeCandidateRejectsEverySignedBindingAndUnknownFrameFields() throws Exception {
        try (var f = new CandidateFixture()) {
            var before = f.quads();
            var original = JSON.parseAny(f.proof.get("payload").getAsString().value()).getAsArray();
            for (int index = 0; index < 12; index++) {
                JsonArray changed = new JsonArray();
                for (int field = 0; field < 12; field++) {
                    if (field == index) changed.add("altered"); else changed.add(original.get(field));
                }
                assertEquals("signed field " + index, "conflict", f.retain(f.candidate, signClaims(changed)).get("status"));
            }
            var legacy = new JsonArray(); for (int index = 0; index < 9; index++) legacy.add(original.get(index));
            assertEquals("conflict", f.retain(f.candidate, signClaims(legacy)).get("status"));
            var frame = copy(f.frame); frame.get("intent").getAsObject().put("sourceGeneration", "caller-generation");
            var candidate = copy(f.candidate); candidate.put("frame", TitleControlPolicy.canonicalCandidateJSON(frame));
            assertEquals("conflict", f.retain(candidate, sign(frame, candidate)).get("status"));
            candidate = copy(f.candidate); candidate.put("ready", true);
            assertEquals("conflict", f.retain(candidate, f.proof).get("status"));
            assertEquals(before, f.quads());
        }
    }
    @Test public void nativeCandidateRequiresFreshAdmissionAndExactHistoryBeforeTerminalShortcut() throws Exception {
        try (var expired = new CandidateFixture(Instant.now().minusSeconds(60))) {
            assertEquals("conflict", expired.retain(expired.candidate, expired.proof).get("status"));
            var lookup = copy(expired.candidate); lookup.put("mode", "lookup");
            assertEquals("conflict", expired.retain(lookup, expired.proof).get("status"));
        }
        try (var f = new CandidateFixture()) {
            assertEquals("accepted", f.retain(f.candidate, f.proof).get("status"));
            f.change(d -> {
                var graph = NodeFactory.createURI(CommandPolicy.RECEIPTS); var own = NodeFactory.createURI(f.receipt);
                d.add(graph, own, NodeFactory.createURI(RV + "outcome"), NodeFactory.createURI(RV + "Cancelled"));
                d.add(graph, own, NodeFactory.createURI(RV + "requestDigest"), NodeFactory.createLiteralString(f.digest));
            });
            var terminal = f.retain(f.candidate, f.proof); assertEquals("terminal", terminal.get("status"));
            assertEquals("cancelled", terminal.get("outcome"));
            var altered = copy(f.frame); altered.get("actor").getAsObject().put("actingSubject", f.main);
            var candidate = copy(f.candidate); candidate.put("frame", TitleControlPolicy.canonicalCandidateJSON(altered));
            assertEquals("conflict", f.retain(candidate, sign(altered, candidate)).get("status"));
        }
    }
    @Test public void nativeCandidateDoesNotRebaseAliasAdoptionHeadOrRawUncertainty() throws Exception {
        for (String mutation : new String[] {"alias", "adoption", "head", "manifest", "planned", "raw"}) {
            try (var f = new CandidateFixture()) {
                assertEquals("accepted", f.retain(f.candidate, f.proof).get("status"));
                f.change(d -> {
                    var current = NodeFactory.createURI(CommandPolicy.CURRENT); var revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
                    switch (mutation) {
                        case "alias" -> d.add(current, NodeFactory.createURI(WORK), NodeFactory.createURI("https://schema.org/alternateName"), NodeFactory.createLiteralString("Late alias"));
                        case "adoption" -> {
                            var realm = NodeFactory.createURI(f.operation); var main = NodeFactory.createURI(f.main);
                            var slot = CanonicalPolicy.realmOwner(realm, main);
                            d.add(current, slot, org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "RealmPublicationSlot"));
                            for (String[] field : new String[][] { {"work", WORK}, {"mainVersion", f.main}, {"realm", f.operation}, {"selectionHead", NEXT} })
                                d.add(current, slot, NodeFactory.createURI(RV + field[0]), NodeFactory.createURI(field[1]));
                        }
                        case "head" -> {
                            d.deleteAny(current, NodeFactory.createURI(WORK), NodeFactory.createURI(RV + "head"), org.apache.jena.graph.Node.ANY);
                            d.add(current, NodeFactory.createURI(WORK), NodeFactory.createURI(RV + "head"), NodeFactory.createURI(NEXT));
                        }
                        case "manifest" -> d.add(revisions, NodeFactory.createURI(HEAD), NodeFactory.createURI(RV + "manifest"), NodeFactory.createURI("urn:rezics:sha256:" + "f".repeat(64)));
                        case "planned" -> d.add(revisions, NodeFactory.createURI(NEXT), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "RevisionAnchor"));
                        case "raw" -> PublicNameProjection.invalidateWorkScopeQualification(f.data);
                        default -> throw new AssertionError(mutation);
                    }
                });
                var beforeRetry = f.quads(); assertEquals(mutation, "conflict", f.retain(f.candidate, f.proof).get("status"));
                assertEquals(beforeRetry, f.quads());
                var lookup = copy(f.candidate); lookup.put("mode", "lookup");
                assertEquals("historical", f.retain(lookup, f.proof).get("status")); assertEquals(beforeRetry, f.quads());
            }
        }
    }
    @Test public void nativeCandidateExpiredOrInterruptedWriterRollsBackPrivateAcceptance() throws Exception {
        try (var f = new CandidateFixture()) {
            var before = f.quads(); var basis = f.basis(); f.data.begin(ReadWrite.WRITE);
            try {
                assertEquals("deadline", TitleControlPolicy.retainCandidate(f.data, f.receipt, f.digest, f.candidate, f.proof, KEY, Long.MIN_VALUE).get("status"));
                f.data.abort();
            } finally { f.data.end(); }
            assertEquals(before, f.quads());
            f.data.begin(ReadWrite.WRITE);
            try {
                var interrupted = new org.apache.jena.sparql.core.DatasetGraphWrapper(f.data) {
                    @Override public void add(org.apache.jena.graph.Node g, org.apache.jena.graph.Node s, org.apache.jena.graph.Node p, org.apache.jena.graph.Node o) {
                        super.add(g, s, p, o);
                        if (p.equals(NodeFactory.createURI(RV + "retainedTitleCandidate"))) Thread.currentThread().interrupt();
                    }
                };
                assertEquals("deadline", TitleControlPolicy.retainCandidate(interrupted, f.receipt, f.digest, f.candidate, f.proof, KEY, Long.MAX_VALUE).get("status"));
                f.data.abort();
            } finally { try { f.data.end(); } finally { Thread.interrupted(); } }
            assertEquals(before, f.quads()); assertEquals(basis, f.basis());
            assertEquals("accepted", f.retain(f.candidate, f.proof).get("status"));
        }
    }

}
