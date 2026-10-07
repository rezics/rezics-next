package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.Method;
import java.math.BigInteger;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonString;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class MetadataRestoreTest {
    private static final String RV = "https://rezics.com/vocab/", PRODUCT = "urn:rezics:dataset:product";
    private static final String MARKER = "urn:rezics:restore:new-epoch", PREFIX = "urn:rezics:name-migration:metadata-restore:";
    private static final String V1 = "https://rezics.com/definition/work-metadata-details-v1", V2 = "https://rezics.com/definition/work-metadata-details-v2";
    private static final String WORK = id(1), COMPONENT = id(2), MANIFEST = "urn:rezics:sha256:" + "a".repeat(64);
    private record Command(String receipt,String digest,String update,String revision,String original) {}
    private static String id(int value) { return "https://rezics.com/id/00000000-0000-0000-0000-%012d".formatted(value); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static String hash(String value) { return MetadataRestorePolicy.templateDigest(value); }
    private static String quote(String value) { return JSON.toStringFlat(new JsonString(value)); }
    private static String array(String... values) { return java.util.Arrays.stream(values).map(MetadataRestoreTest::quote)
        .collect(java.util.stream.Collectors.joining(",", "[", "]")); }
    @Test public void maintenanceIdentityMatchesTypeScriptCompactJsonVector() {
        assertEquals("fd515bace0a248963f34238146aa032e0aa26c7c5922443c66094644c63b2787",
            command(false,false,900,4,null,20).digest());
    }
    private static String graph(String graph,String facts) { return " GRAPH <" + graph + "> { " + facts + " } "; }
    private static String state(boolean v2,boolean withdrawn) {
        return "{\"kind\":\"edition\",\"id\":\"" + COMPONENT + "\",\"status\":\"" + (withdrawn ? "withdrawn" : "active")
            + "\",\"title\":{\"value\":\"Café edition\",\"language\":\"fr\"},"
            + (v2 ? "\"contentLanguages\":[\"en\",\"fr\"],\"isTranslation\":true,\"originalLanguages\":[\"ja\"],\"titleLanguage\":null,\"tracklistLanguage\":\"fr\","
                : "\"contentLanguage\":\"fr\",")
            + "\"editionStatement\":\"Second edition\",\"publisher\":\"Exact publisher\",\"publicationYear\":2025,\"isbn13\":null}";
    }
    private static Command command(boolean v2,boolean withdrawn,int diagnostic,int main,String predecessor,int revisionNumber) {
        return command(v2,withdrawn,diagnostic,main,predecessor,revisionNumber,state(v2,withdrawn));
    }
    private static Command command(boolean v2,boolean withdrawn,int diagnostic,int main,String predecessor,int revisionNumber,String state) {
        String revision = id(revisionNumber), model = v2 ? V2 : V1;
        String admission = "00000000-0000-0000-0000-%012d".formatted(revisionNumber);
        String sourceReceipt = "urn:rezics:receipt:" + hash(admission + '\0' + "edit-metadata-work");
        String payload = "b".repeat(64);
        String request = "{\"profile\":" + quote(model) + ",\"work\":" + quote(WORK) + ",\"expectedHead\":"
            + (predecessor == null ? "null" : quote(predecessor)) + ",\"state\":" + state + "}";
        String sourceDigest = hash(request);
        String digest = hash(array("held-slim-metadata-restore-v1","new-epoch","9",sourceReceipt,sourceDigest,payload,
            "old-epoch",Integer.toString(diagnostic),Integer.toString(main),COMPONENT,revision));
        String receipt = PREFIX + digest;
        var recorded = JSON.parse(state);
        StringBuilder languageFacts = new StringBuilder();
        if (v2) {
            List<String> content = languageArray(recorded.get("contentLanguages")), originals = languageArray(recorded.get("originalLanguages"));
            if (!content.isEmpty()) languageFacts.append(" ; rv:contentLanguages ").append(quote(String.join(" ",content)));
            if (content.size() == 1) languageFacts.append(" ; rv:editionLanguage ").append(quote(content.getFirst()));
            if (!originals.isEmpty()) languageFacts.append(" ; rv:originalLanguages ").append(quote(String.join(" ",originals)));
            if (recorded.get("isTranslation").getAsBoolean().value()) languageFacts.append(" ; rv:isTranslation \"true\"");
            for (String field : List.of("titleLanguage","tracklistLanguage")) if (!recorded.get(field).isNull())
                languageFacts.append(" ; rv:").append(field).append(' ').append(quote(recorded.get(field).getAsString().value()));
        } else if (!recorded.get("contentLanguage").isNull()) languageFacts.append(" ; rv:editionLanguage ").append(quote(recorded.get("contentLanguage").getAsString().value()));
        String current = "<" + COMPONENT + "> a rv:" + (v2 ? "EditionRecord" : "WorkMetadataComponent")
            + " ; rv:work <" + WORK + "> ; rv:metadataKind \"edition\" ; rv:metadataHead <" + revision
            + "> ; rv:editionState rv:" + (withdrawn ? "Withdrawn" : "Active") + languageFacts + " . <" + WORK + "> rv:editionsRevision <" + revision + "> .";
        String revisions = "<" + revision + "> a rv:" + (v2 ? "WorkMetadataDetailsV2Revision" : "WorkMetadataRevision")
            + ", rv:RevisionAnchor ; rv:component <" + COMPONENT + "> ; rv:metadataState " + quote(state)
            + " ; rv:manifest <" + MANIFEST + "> ; rv:modelRevision <" + model + "> ; rv:shapeRevision <" + model
            + "> ; rv:datasetId <" + PRODUCT + "> ; rv:dataEpoch \"old-epoch\" ; rv:sequence " + diagnostic
            + (predecessor == null ? " ." : " ; rv:predecessor <" + predecessor + "> .");
        String own = "<" + receipt + "> a rv:OperationReceipt ; rv:commandFamily \"metadata-restore-v1\" ; rv:requestDigest " + quote(digest)
            + " ; rv:outcome rv:Succeeded ; rv:datasetId <" + PRODUCT + "> ; rv:dataEpoch \"new-epoch\" ; rv:sequence 0 ; rv:work <" + WORK
            + "> ; rv:sourceReceipt <" + sourceReceipt + "> ; rv:sourceDigest " + quote(sourceDigest) + " ; rv:sourcePayloadDigest " + quote(payload)
            + " ; rv:sourceDataEpoch \"old-epoch\" ; rv:sourceSequence " + diagnostic + " ; rv:sourceMainSequence " + main
            + " ; rv:sourceAdmissionId " + quote(admission) + " ; rv:sourceAuthorityEpoch \"2\" ; rv:sourceScope " + quote("work:edit:" + WORK)
            + " ; rv:sourcePredecessor <" + (predecessor == null ? COMPONENT : predecessor) + "> ; rv:metadataComponent <" + COMPONENT
            + "> ; rv:metadataRevision <" + revision + "> ; rv:metadataManifest <" + MANIFEST + "> ; rv:metadataModel <" + model + "> .";
        String update = "PREFIX rv: <" + RV + "> DELETE { " + graph(CommandPolicy.CONTROL,"<" + MARKER
            + "> rv:reconciledPriorSequence ?last ; rv:reconciledPriorMainSequence ?lastMain .")
            + graph(CommandPolicy.CURRENT,"<" + WORK + "> rv:editionsRevision ?priorEdition .") + " } INSERT { "
            + graph(CommandPolicy.CURRENT,current) + graph(CommandPolicy.REVISIONS,revisions) + graph(CommandPolicy.RECEIPTS,own)
            + graph(CommandPolicy.CONTROL,"<" + MARKER + "> rv:reconciledPriorSequence " + diagnostic + " ; rv:reconciledPriorMainSequence " + main + " .")
            + " } WHERE { " + graph(CommandPolicy.CONTROL,"<" + PRODUCT + "> rv:dataEpoch \"new-epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover <" + MARKER + "> .") + " }";
        return new Command(receipt,digest,update,revision,sourceReceipt);
    }
    private static List<String> languageArray(org.apache.jena.atlas.json.JsonValue value) {
        List<String> result = new java.util.ArrayList<>(); for (var item : value.getAsArray()) result.add(item.getAsString().value()); return result;
    }
    private static DatasetGraph dataset() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { "
            + graph(CommandPolicy.CONTROL,"<" + PRODUCT + "> rv:dataEpoch \"new-epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover <" + MARKER
                + "> . <" + MARKER + "> rv:priorDataEpoch \"old-epoch\" ; rv:priorSequence 800 ; rv:priorMainSequence 3 . <" + CommandInvariant.MAIN_STREAM_SCOPE
                + "> rv:dataEpoch \"new-epoch\" ; rv:streamSequence 0 ; rv:legacyThroughSequence 0 .")
            + graph(CommandPolicy.CURRENT,"<" + WORK + "> a <https://schema.org/CreativeWork> ; rv:head <" + id(10) + "> .") + " }",DatasetFactory.wrap(data));
        data.commit(); data.end(); return data;
    }
    @SuppressWarnings("unchecked")
    private static List<Quad> projection(DatasetGraph logical,Node component,Node revision,Node manifest,Node model) {
        try {
            Method publicFacts = CommandService.class.getDeclaredMethod("editionPublicFacts",DatasetGraph.class,Node.class,Node.class); publicFacts.setAccessible(true);
            List<Quad> facts = new java.util.ArrayList<>();
            var iter = logical.find(uri(CommandPolicy.CURRENT),component,Node.ANY,Node.ANY);
            while (iter.hasNext()) { Quad quad = iter.next(); facts.add(new Quad(Quad.defaultGraphNodeGenerated,quad.asTriple())); }
            facts.addAll((List<Quad>)publicFacts.invoke(null,logical,component,revision));
            facts.add(new Quad(Quad.defaultGraphNodeGenerated,component,uri(RV + "manifest"),manifest));
            facts.add(new Quad(Quad.defaultGraphNodeGenerated,component,uri(RV + "modelRevision"),model));
            return facts;
        } catch (ReflectiveOperationException ex) { throw new IllegalArgumentException(ex); }
    }
    private static MetadataRestorePolicy.Snapshot capture(DatasetGraph data,Command command) {
        return MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),MetadataRestoreTest::projection);
    }
    private static Set<Quad> record(DatasetGraph data,Node graph,Node subject) {
        Set<Quad> result = new HashSet<>(); data.find(graph,subject,Node.ANY,Node.ANY).forEachRemaining(result::add); return result;
    }
    @Test public void retiredProofRestorePreservesUnequalPositionsAndKeepsHistoryInOwnerCustody() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command command = command(false,false,900,4,null,20);
            Set<Quad> stream = record(data,uri(CommandPolicy.CONTROL),uri(CommandInvariant.MAIN_STREAM_SCOPE));
            MetadataRestorePolicy.Snapshot snapshot = capture(data,command); assertNull(snapshot.error());
            assertTrue(snapshot.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),Node.ANY));
            MetadataRestorePolicy.apply(data,snapshot); assertNull(MetadataRestorePolicy.check(data,snapshot));
            assertEquals(BigInteger.ZERO,CommandInvariant.readControl(data).sequence());
            assertEquals(BigInteger.valueOf(900),CommandInvariant.readControl(data).cursor());
            assertEquals(stream,record(data,uri(CommandPolicy.CONTROL),uri(CommandInvariant.MAIN_STREAM_SCOPE)));
            assertFalse(data.contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),Node.ANY,Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.original()),Node.ANY,Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.OUTBOX),Node.ANY,Node.ANY,Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),NodeFactory.createLiteralLang("Café edition","fr")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void v2SuccessorWithdrawalUsesExactLocalCasAndRemovesPublicFacts() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command first = command(true,false,900,4,null,20); var one = capture(data,first); assertNull(one.error()); MetadataRestorePolicy.apply(data,one);
            Set<Quad> firstReceipt = record(data,uri(CommandPolicy.RECEIPTS),uri(first.receipt()));
            Command second = command(true,true,950,5,first.revision(),21); var two = capture(data,second); assertNull(two.error()); MetadataRestorePolicy.apply(data,two);
            assertNull(MetadataRestorePolicy.check(data,two));
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "contentLanguages"),NodeFactory.createLiteralString("en fr")));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "metadataHead"),uri(second.revision())));
            assertEquals(firstReceipt,record(data,uri(CommandPolicy.RECEIPTS),uri(first.receipt())));
            assertNotNull(capture(data,command(true,false,951,6,first.revision(),22)).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void interruptedPhysicalRestoreRollsBackAndReusesTheSameSource() {
        DatasetGraph data = dataset(); Command command = command(false,false,900,4,null,20);
        try {
            data.begin(ReadWrite.WRITE); var failed = capture(data,command); assertNull(failed.error());
            DatasetGraph interrupted = new DatasetGraphWrapper(data) {
                @Override public void add(Node graph,Node subject,Node predicate,Node object) {
                    if (subject.equals(uri(COMPONENT)) && predicate.equals(uri(RV + "manifest")))
                        throw new IllegalStateException("injected interrupted metadata persistence");
                    super.add(graph,subject,predicate,object);
                }
            };
            assertThrows(IllegalStateException.class,() -> MetadataRestorePolicy.apply(interrupted,failed)); data.abort(); data.end();
            data.begin(ReadWrite.WRITE); var retry = capture(data,command); assertNull(retry.error()); MetadataRestorePolicy.apply(data,retry); assertNull(MetadataRestorePolicy.check(data,retry));
            assertEquals(command.digest(),data.find(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),Node.ANY).next().getObject().getLiteralLexicalForm());
            data.commit(); data.end();
        } finally { if (data.isInTransaction()) { data.abort(); data.end(); } data.close(); }
    }
    @Test public void wrongCursorAuthorityDigestExtraHistoryAndPartialRestoreAreRefused() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command original = command(false,false,900,4,null,20);
            assertNotNull(capture(data,command(false,false,800,4,null,20)).error());
            assertNotNull(capture(data,command(false,false,900,900,null,20)).error());
            for (String altered : List.of(original.update().replace("rv:sourceScope \"work:edit:","rv:sourceScope \"forged:"),
                original.update().replace("rv:sourceAuthorityEpoch \"2\"","rv:sourceAuthorityEpoch \"bad\""),
                original.update().replace("rv:sourceDigest \"","rv:sourceDigest \"0"),
                original.update().replace("Café edition","Different retained state"),
                original.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.REVISIONS,"<" + id(90) + "> a rv:Agent .")),
                original.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.OUTBOX,"<urn:forged> a rv:OutboxBatch .")))) {
                try { assertNotNull(capture(data,new Command(original.receipt(),original.digest(),altered,original.revision(),original.original())).error()); }
                catch (IllegalArgumentException expected) { /* native closed footprint */ }
            }
            data.add(uri(CommandPolicy.RECEIPTS),uri(original.receipt()),uri(RV + "partial"),NodeFactory.createLiteralString("incomplete"));
            assertNotNull(capture(data,original).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void erasedSourcesMissingSavedMainCutAndOversizedComponentsStayHeld() {
        for (String condition : List.of("erased","missing-main","oversized")) {
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                Command original = command(false,false,900,4,null,20);
                if (condition.equals("erased")) data.add(uri(CommandPolicy.REVISIONS),uri(id(10)),org.apache.jena.vocabulary.RDF.type.asNode(),uri(RV + "ErasedRevision"));
                if (condition.equals("missing-main")) data.deleteAny(uri(CommandPolicy.CONTROL),uri(MARKER),uri(RV + "priorMainSequence"),Node.ANY);
                if (condition.equals("oversized")) for (int index=0;index<65;index++) data.add(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "extra" + index),NodeFactory.createLiteralString("value"));
                assertNotNull(capture(data,original).error());
                assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void competingCasSnapshotsCannotBeAdoptedAfterAnotherRestoreCommits() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command first = command(false,false,900,4,null,20), other = command(false,false,901,4,null,21);
            var admitted = capture(data,first); assertNull(admitted.error()); assertNull(capture(data,other).error());
            MetadataRestorePolicy.apply(data,admitted);
            assertNotNull(capture(data,other).error());
            assertNotEquals(MetadataRestorePolicy.templateDigest(first.update()),MetadataRestorePolicy.templateDigest(first.update() + "\n"));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void erasedPublishedContentRefusesEditionRestoreBeforeProjection() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
            Node variant = uri(id(30)), publication = uri(id(31)), content = uri("urn:rezics:content:revision:00000000-0000-0000-0000-000000000032");
            data.add(current,variant,uri(RV + "resource"),uri(WORK));
            data.add(current,variant,uri(RV + "contentPublicationHead"),publication);
            data.add(revisions,publication,uri(RV + "contentRevision"),content);
            data.add(revisions,content,org.apache.jena.vocabulary.RDF.type.asNode(),uri(RV + "ErasedRevision"));
            boolean[] projected = { false }; Command command = command(false,false,900,4,null,20);
            var result = MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),
                (logical,component,revision,manifest,model) -> { projected[0] = true; return projection(logical,component,revision,manifest,model); });
            assertNotNull(result.error()); assertFalse(projected[0]);
            assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void halfRestoredCursorsAndMissingSavedCutCannotSupplyRecoveryOrder() {
        for (String condition : List.of("diagnostic-only","main-only","missing-saved-main")) {
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                Node control = uri(CommandPolicy.CONTROL), marker = uri(MARKER);
                if (!condition.equals("main-only")) data.add(control,marker,uri(RV + "reconciledPriorSequence"),NodeFactory.createLiteralByValue(850,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                if (!condition.equals("diagnostic-only")) data.add(control,marker,uri(RV + "reconciledPriorMainSequence"),NodeFactory.createLiteralByValue(3,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                if (condition.equals("missing-saved-main")) data.deleteAny(control,marker,uri(RV + "priorMainSequence"),Node.ANY);
                assertNotNull(capture(data,command(false,false,900,4,null,20)).error());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void scriptAndRegionSpellingSurvivesFullV1AndV2RestoreWithOriginalDigests() {
        String v1 = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":\"en-US\"")
            .replace("\"language\":\"fr\"","\"language\":\"zh-Hans\"");
        String v2 = state(true,false).replace("[\"en\",\"fr\"]","[\"en-US\",\"sr-Latn\",\"zh-Hans\"]")
            .replace("[\"ja\"]","[\"sr-Latn\",\"zh-Hans\"]")
            .replace("\"titleLanguage\":null","\"titleLanguage\":\"en-US\"")
            .replace("\"tracklistLanguage\":\"fr\"","\"tracklistLanguage\":\"sr-Latn\"");
        for (boolean revised : List.of(false,true)) {
            String recorded = revised ? v2 : v1; Command command = command(revised,false,900,4,null,20,recorded);
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                var restored = capture(data,command); assertNull(restored.error());
                assertTrue(restored.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),NodeFactory.createLiteralString(recorded)));
                MetadataRestorePolicy.apply(data,restored); assertNull(MetadataRestorePolicy.check(data,restored));
                String field = revised ? "contentLanguages" : "editionLanguage";
                String exact = revised ? "en-US sr-Latn zh-Hans" : "en-US";
                assertEquals(exact,data.find(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + field),Node.ANY).next().getObject().getLiteralLexicalForm());
                if (revised) {
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "originalLanguages"),NodeFactory.createLiteralString("sr-Latn zh-Hans")));
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "titleLanguage"),NodeFactory.createLiteralString("en-US")));
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "tracklistLanguage"),NodeFactory.createLiteralString("sr-Latn")));
                } else assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),NodeFactory.createLiteralLang("Café edition","zh-Hans")));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "manifest"),uri(MANIFEST)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "modelRevision"),uri(revised ? V2 : V1)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "metadataHead"),uri(command.revision())));
                String sourceDigest = hash("{\"profile\":" + quote(revised ? V2 : V1) + ",\"work\":" + quote(WORK) + ",\"expectedHead\":null,\"state\":" + recorded + "}");
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "sourceDigest"),NodeFactory.createLiteralString(sourceDigest)));
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),NodeFactory.createLiteralString(command.digest())));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void recordedPrivateExtlangGrandfatheredVariantAndExtensionFormsRestoreWithoutNormalization() {
        for (String tag : List.of("x-private","i-default","en-gb-oed","zh-cmn-hans-cn","sl-biske-rozaj","de-DE-1996-u-co-phonebk")) {
            String recorded = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":" + quote(tag));
            Command command = command(false,false,900,4,null,20,recorded); DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                var restored = capture(data,command); assertNull(tag + ": " + restored.error(),restored.error());
                MetadataRestorePolicy.apply(data,restored); assertNull(MetadataRestorePolicy.check(data,restored));
                assertEquals(tag,data.find(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "editionLanguage"),Node.ANY).next().getObject().getLiteralLexicalForm());
                assertTrue(restored.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),NodeFactory.createLiteralString(recorded)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "manifest"),uri(MANIFEST)));
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),NodeFactory.createLiteralString(command.digest())));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void malformedLanguageAndCaseInsensitiveDuplicateVariantsOrSingletonsStayHeldBeforeProjection() {
        for (String tag : List.of("en_US","en--US","en-a","x","a-US","en-abcdefghi","en-US-US"," en-US","en-US ",
            "sl-rozaj-rozaj","sl-rozaj-ROZAJ","en-a-foo-a-bar","en-a-foo-A-bar","en-u-ca-gregory-U-nu-latn")) {
            String recorded = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":" + quote(tag));
            Command command = command(false,false,900,4,null,20,recorded); DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                boolean[] projected = { false };
                var restored = MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),
                    (logical,component,revision,manifest,model) -> { projected[0] = true; return projection(logical,component,revision,manifest,model); });
                assertNotNull(tag,restored.error()); assertFalse(tag,projected[0]);
                assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
                assertFalse(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),Node.ANY,Node.ANY));
            } finally { data.abort(); data.end(); data.close(); }
        }
        String duplicates = state(true,false).replace("[\"en\",\"fr\"]","[\"en-US\",\"en-us\"]");
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try { assertNotNull(capture(data,command(true,false,900,4,null,20,duplicates)).error()); }
        finally { data.abort(); data.end(); data.close(); }
    }
}
