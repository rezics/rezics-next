package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class WorkStructurePublicationGuardTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String MAIN = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String STRUCTURE = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String REVISION = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String GENERATION = "https://rezics.com/id/00000000-0000-4000-8000-000000000005";
    private static final String DECISION = "https://rezics.com/id/00000000-0000-4000-8000-000000000006";
    private static final String SOURCE = "urn:rezics:work-source:guard-test";
    private static final String RECEIPT = "urn:rezics:receipt:work-publication-head-test";
    private static final String ADMISSION = "00000000-0000-4000-8000-000000000007";
    private static final String ROOT = "urn:rezics:sha256:" + "a".repeat(64);
    private static final String OBSERVATION = "https://rezics.com/id/00000000-0000-4000-8000-000000000009";

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static String nt(String value) { return "<" + value + ">"; }
    private static int count(DatasetGraph data, Node graph, Node subject, Node predicate) {
        int count = 0;
        var rows = data.find(graph, subject, predicate, Node.ANY);
        while (rows.hasNext()) { rows.next(); count++; }
        return count;
    }

    private static DatasetGraph publication() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
        Node work = uri(WORK), main = uri(MAIN), structure = uri(STRUCTURE), revision = uri(REVISION);
        Node generation = uri(GENERATION), decision = uri(DECISION), source = uri(SOURCE), root = uri(ROOT);
        data.add(current, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
        data.add(current, work, p("mainVersion"), main);
        data.add(current, main, RDF.type.asNode(), p("MainVersion"));
        data.add(current, main, p("work"), work);
        data.add(current, work, p("workStructurePublicationHead"), decision);
        data.add(current, structure, RDF.type.asNode(), p("Structure"));
        data.add(current, structure, p("structureOf"), main);
        data.add(current, structure, p("structureProfile"), p("RecipeComposition"));
        data.add(current, generation, RDF.type.asNode(), p("StructureGeneration"));
        data.add(current, generation, p("structure"), structure);
        data.add(revisions, decision, RDF.type.asNode(), p("WorkStructurePublicationDecision"));
        data.add(revisions, decision, RDF.type.asNode(), p("RevisionAnchor"));
        data.add(revisions, decision, p("component"), work);
        data.add(revisions, decision, p("publicationOutcome"), p("Published"));
        data.add(revisions, decision, p("publicSource"), source);
        data.add(revisions, decision, p("disclosure"), p("Public"));
        data.add(revisions, decision, p("rightsBasis"), p("OriginalContribution"));
        data.add(revisions, source, RDF.type.asNode(), p("WorkStructurePublicSource"));
        data.add(revisions, source, p("work"), work);
        data.add(revisions, source, p("component"), main);
        data.add(revisions, source, p("structureProfile"), p("RecipeComposition"));
        data.add(revisions, source, p("structure"), structure);
        data.add(revisions, source, p("structureRevision"), revision);
        data.add(revisions, source, p("selectedGeneration"), generation);
        data.add(revisions, source, p("sourceRoot"), root);
        data.add(revisions, revision, RDF.type.asNode(), p("StructureRevision"));
        data.add(revisions, revision, p("component"), structure);
        data.add(revisions, revision, p("generation"), generation);
        data.add(revisions, revision, p("manifest"), root);
        return data;
    }

    private static String deleteUpdate(String subject, String predicate, boolean addHead) {
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + nt(CommandPolicy.CURRENT) + " { "
            + nt(subject) + " " + predicate + " ?value } } INSERT { GRAPH " + nt(CommandPolicy.CURRENT)
            + " { " + nt(subject) + " a <https://schema.org/Person>"
            + (addHead ? " ; rv:workStructurePublicationHead " + nt(DECISION) : "")
            + " } GRAPH " + nt(CommandPolicy.RECEIPTS) + " { " + nt(RECEIPT)
            + " a rv:OperationReceipt } } WHERE { GRAPH " + nt(CommandPolicy.CURRENT) + " { "
            + nt(subject) + " " + predicate + " ?value } }";
    }

    private static void put(DatasetGraph data, String graph, String subject, String property, Node value) {
        data.deleteAny(uri(graph), uri(subject), p(property), Node.ANY);
        data.add(uri(graph), uri(subject), p(property), value);
    }

    private static List<CommandService.Validation> focuses(String workProfile, String decisionProfile,
        String sourceProfile) {
        return java.util.stream.IntStream.range(0, 3).mapToObj(i -> {
            String profile = List.of(workProfile, decisionProfile, sourceProfile).get(i);
            return new CommandService.Validation(profile, null,
                "https://rezics.com/definition/" + profile + "/" + List.of("work-shape", "decision-shape", "source-shape").get(i),
                List.of(List.of(WORK, DECISION, SOURCE).get(i)),
                List.of(i == 0 ? CommandPolicy.CURRENT : CommandPolicy.REVISIONS), Map.of());
        }).toList();
    }

    private static void bindReceipt(DatasetGraph data) {
        String revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
        data.add(uri(receipts), uri(RECEIPT), RDF.type.asNode(), p("OperationReceipt"));
        put(data, receipts, RECEIPT, "outcome", p("Succeeded"));
        put(data, receipts, RECEIPT, "work", uri(WORK));
        put(data, receipts, RECEIPT, "publicationDecision", uri(DECISION));
        put(data, receipts, RECEIPT, "mainVersion", uri(MAIN));
        put(data, receipts, RECEIPT, "action", NodeFactory.createLiteralString("work.publish"));
        put(data, receipts, RECEIPT, "commandFamily", NodeFactory.createLiteralString("work-structure-publication-v1"));
        var identity = Map.of("attestedBy", uri(MAIN), "admissionId", NodeFactory.createLiteralString(ADMISSION),
            "admittedScope", NodeFactory.createLiteralString("work:publish:" + WORK),
            "authorityEpoch", NodeFactory.createLiteralString("0"), "requestDigest", NodeFactory.createLiteralString("b".repeat(64)),
            "datasetId", uri("urn:rezics:dataset:product"), "dataEpoch", NodeFactory.createLiteralString(ADMISSION),
            "sequence", NodeFactory.createLiteralByValue(1, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        for (String field : identity.keySet()) {
            Node value = identity.get(field);
            put(data, revisions, DECISION, field, value);
            put(data, receipts, RECEIPT, field, value);
            if (List.of("dataEpoch", "sequence").contains(field))
                put(data, CommandPolicy.CONTROL, "urn:rezics:dataset:product", field, value);
        }
        for (String field : List.of("structure", "structureProfile", "structureRevision", "selectedGeneration", "sourceRoot"))
            put(data, receipts, RECEIPT, field, data.find(uri(revisions), uri(SOURCE), p(field), Node.ANY).next().getObject());
        for (String field : List.of("rightsBasis", "disclosure"))
            put(data, receipts, RECEIPT, field, data.find(uri(revisions), uri(DECISION), p(field), Node.ANY).next().getObject());
    }

    private static void assertReceiptReplay(DatasetGraph data) {
        data.commit(); data.end();
        try {
            var service = SlimCommandTest.service(SlimCommandTest.profiles());
            for (String digest : List.of("b".repeat(64), "c".repeat(64)))
                assertEquals(digest.startsWith("b") ? "committed" : "conflict",
                    service.runCommand(data, RECEIPT, digest, update(null, null), List.of(),
                        System.nanoTime() + 30_000_000_000L).get("status"));
        } finally { data.begin(ReadWrite.WRITE); }
        assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"), uri(DECISION)));
    }

    @Test public void manualPublicDomainPublicationPinsAssessmentWithoutInventingSourceObservation() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            String revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            Node assessment = uri("urn:rezics:rights:assessment:" + ADMISSION);
            String profile = "work-structure-publication-v2";
            for (String field : List.of("modelRevision", "shapeRevision"))
                put(data, revisions, DECISION, field, uri("https://rezics.com/definition/" + profile));
            put(data, revisions, DECISION, "rightsBasis", p("PublicDomain"));
            for (String subject : List.of(DECISION, SOURCE))
                put(data, revisions, subject, "rightsAssessment", assessment);
            data.add(uri(revisions), uri(SOURCE), uri("https://schema.org/citation"),
                NodeFactory.createLiteralString("{\"kind\":\"manual-citation\"}"));
            bindReceipt(data);
            put(data, receipts, RECEIPT, "rightsAssessment", assessment);
            assertNull(CommandService.workStructurePublicationHeadScope(data, WORK,
                focuses(profile, profile, profile), Set.of(WORK)));
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
            for (String subject : List.of(DECISION, SOURCE, RECEIPT)) {
                String graph = subject.equals(RECEIPT) ? receipts : revisions;
                data.deleteAny(uri(graph), uri(subject), p("rightsAssessment"), Node.ANY);
                assertNotNull(subject, CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, graph, subject, "rightsAssessment", uri("urn:rezics:rights:assessment:" + WORK.substring(WORK.length() - 36)));
                assertNotNull(subject, CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, graph, subject, "rightsAssessment", assessment);
                data.add(uri(graph), uri(subject), p("rightsAssessment"), uri(OBSERVATION));
                assertNotNull(subject, CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, graph, subject, "rightsAssessment", assessment);
                put(data, graph, subject, "sourceObservation", uri(OBSERVATION));
                assertNotNull(subject, CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                data.deleteAny(uri(graph), uri(subject), p("sourceObservation"), Node.ANY);
                assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
            }
            for (String subject : List.of(DECISION, SOURCE, RECEIPT))
                put(data, subject.equals(RECEIPT) ? receipts : revisions, subject, "rightsAssessment",
                    uri("urn:rezics:rights:assessment:invalid"));
            assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void truthfulPublicDomainPoststateAdmitsOnlyConsistentV2FocusesAndExactReceiptBindings() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            String v1 = "work-structure-publication-v1", v2 = "work-structure-publication-v2";
            String revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            for (String field : List.of("modelRevision", "shapeRevision"))
                put(data, revisions, DECISION, field, uri("https://rezics.com/definition/" + v2));
            put(data, revisions, DECISION, "rightsBasis", p("PublicDomain"));
            for (String subject : List.of(DECISION, SOURCE))
                put(data, revisions, subject, "sourceObservation", uri(OBSERVATION));
            bindReceipt(data);
            put(data, receipts, RECEIPT, "sourceObservation", uri(OBSERVATION));
            assertNull(CommandService.workStructurePublicationHeadScope(data, WORK, focuses(v2, v2, v2), Set.of(WORK)));
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
            assertReceiptReplay(data);
            for (int i = 0; i < 3; i++) {
                var valid = focuses(v2, v2, v2);
                var entry = valid.get(i);
                String shape = List.of("work-shape", "decision-shape", "source-shape").get(i);
                String subject = List.of(WORK, DECISION, SOURCE).get(i);
                assertTrue(CommandService.hasWorkStructurePublicationFocus(data, valid, shape, subject));
                for (var wrong : List.of(
                    new CommandService.Validation(v2, null, entry.shape(), List.of(MAIN), entry.graphs(), Map.of()),
                    new CommandService.Validation(v2, null, entry.shape(), entry.focus(), List.of(CommandPolicy.SOURCE), Map.of()),
                    new CommandService.Validation(v2, null, entry.shape() + "-other", entry.focus(), entry.graphs(), Map.of()))) {
                    var changed = new java.util.ArrayList<>(valid);
                    changed.set(i, wrong);
                    assertTrue(!CommandService.hasWorkStructurePublicationFocus(data, changed, shape, subject));
                }
            }
            for (String profile : List.of(v1, "work-structure-publication-v3"))
                assertNotNull(CommandService.workStructurePublicationHeadScope(data, WORK,
                    focuses(profile, profile, profile), Set.of(WORK)));
            for (var mixed : List.of(focuses(v1, v2, v2), focuses(v2, v1, v2), focuses(v2, v2, v1)))
                assertNotNull(CommandService.workStructurePublicationHeadScope(data, WORK, mixed, Set.of(WORK)));
            for (String field : List.of("attestedBy", "admissionId", "admittedScope", "authorityEpoch", "requestDigest",
                "datasetId", "dataEpoch", "sequence", "rightsBasis", "disclosure", "sourceObservation", "work",
                "publicationDecision", "mainVersion", "structure", "structureProfile", "structureRevision",
                "selectedGeneration", "sourceRoot", "action", "commandFamily")) {
                Node original = data.find(uri(receipts), uri(RECEIPT), p(field), Node.ANY).next().getObject();
                put(data, receipts, RECEIPT, field, uri("urn:rezics:wrong-binding"));
                assertNotNull(field, CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, receipts, RECEIPT, field, original);
            }
            for (String subject : List.of(DECISION, SOURCE)) {
                put(data, revisions, subject, "sourceObservation", uri(MAIN));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, revisions, subject, "sourceObservation", uri(OBSERVATION));
                data.add(uri(revisions), uri(subject), p("sourceObservation"), uri(MAIN));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                data.deleteAny(uri(revisions), uri(subject), p("sourceObservation"), Node.ANY);
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                put(data, revisions, subject, "sourceObservation", uri(OBSERVATION));
            }
            for (String basis : List.of("UnknownRights", "OriginalContribution")) {
                put(data, revisions, DECISION, "rightsBasis", p(basis));
                put(data, receipts, RECEIPT, "rightsBasis", p(basis));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
            }
            put(data, revisions, DECISION, "rightsBasis", p("PublicDomain"));
            for (String field : List.of("modelRevision", "shapeRevision")) {
                data.deleteAny(uri(revisions), uri(DECISION), p(field), Node.ANY);
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
                put(data, revisions, DECISION, field, uri("https://rezics.com/definition/" + v2));
                data.add(uri(revisions), uri(DECISION), p(field), uri("https://rezics.com/definition/" + v1));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
                put(data, revisions, DECISION, field, uri("https://rezics.com/definition/" + v2));
            }
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void publicDomainWithoutObservationIsRefusedWhileOriginalNeedsNone() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
            for (String field : List.of("modelRevision", "shapeRevision"))
                put(data, CommandPolicy.REVISIONS, DECISION, field,
                    uri("https://rezics.com/definition/work-structure-publication-v2"));
            put(data, CommandPolicy.REVISIONS, DECISION, "rightsBasis", p("PublicDomain"));
            assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
            put(data, CommandPolicy.REVISIONS, DECISION, "sourceObservation", uri(OBSERVATION));
            assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
            put(data, CommandPolicy.REVISIONS, SOURCE, "sourceObservation", uri(OBSERVATION));
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void originalAndWithdrawalRetainV1FamiliesUnderEitherAdmittedRevision() {
        for (String profile : List.of("work-structure-publication-v1", "work-structure-publication-v2")) {
            DatasetGraph data = publication();
            data.begin(ReadWrite.WRITE);
            try {
                for (String field : List.of("modelRevision", "shapeRevision"))
                    put(data, CommandPolicy.REVISIONS, DECISION, field, uri("https://rezics.com/definition/" + profile));
                bindReceipt(data);
                var validations = focuses(profile, profile, profile);
                assertNull(CommandService.workStructurePublicationHeadScope(data, WORK, validations, Set.of(WORK)));
                assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                assertReceiptReplay(data);
                put(data, CommandPolicy.RECEIPTS, RECEIPT, "sourceObservation", uri(OBSERVATION));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                data.deleteAny(uri(CommandPolicy.RECEIPTS), uri(RECEIPT), p("sourceObservation"), Node.ANY);
                if (profile.endsWith("-v1")) for (String field : List.of("modelRevision", "shapeRevision")) {
                    data.deleteAny(uri(CommandPolicy.REVISIONS), uri(DECISION), p(field), Node.ANY);
                    assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                    put(data, CommandPolicy.REVISIONS, DECISION, field, uri("https://rezics.com/definition/" + profile));
                }
                data.deleteAny(uri(CommandPolicy.REVISIONS), uri(DECISION), p("publicSource"), Node.ANY);
                put(data, CommandPolicy.REVISIONS, DECISION, "publicationOutcome", p("Withdrawn"));
                put(data, CommandPolicy.RECEIPTS, RECEIPT, "action", NodeFactory.createLiteralString("work.withdraw-publication"));
                put(data, CommandPolicy.RECEIPTS, RECEIPT, "commandFamily", NodeFactory.createLiteralString("work-structure-withdrawal-v1"));
                assertNull(CommandService.workStructurePublicationHeadScope(data, WORK, validations.subList(0, 2), Set.of(WORK)));
                assertNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
                data.add(uri(CommandPolicy.REVISIONS), uri(DECISION), p("publicSource"), uri(SOURCE));
                assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, RECEIPT, DECISION));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }

    private static String publicationScopeAfterUpdate(DatasetGraph data, String subject, String update,
        Set<String> expectedChanges) {
        var plan = CommandPolicy.parse(update, RECEIPT);
        var changed = CommandService.workStructurePublicationHeadChanges(data, plan);
        assertEquals(expectedChanges, changed);
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
        return CommandService.workStructurePublicationHeadScope(data, subject, List.of(), changed);
    }

    @Test public void wildcardDeleteWithoutPublicationHeadRequiresNoPublicationFocus() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.CURRENT), uri(MAIN), RDF.type.asNode(), uri("https://schema.org/Person"));
            assertNull(publicationScopeAfterUpdate(data, MAIN, deleteUpdate(MAIN, "?predicate", false), Set.of()));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"),
                uri(DECISION)));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void wildcardDeleteOfExistingPublicationHeadStillRequiresPublicationFocus() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals("Work structure publication focus omitted: " + WORK,
                publicationScopeAfterUpdate(data, WORK, deleteUpdate(WORK, "?predicate", false), Set.of(WORK)));
            assertEquals(0, count(data, uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead")));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void explicitPublicationHeadDeleteStillRequiresPublicationFocus() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals("Work structure publication focus omitted: " + WORK,
                publicationScopeAfterUpdate(data, WORK, deleteUpdate(WORK, "rv:workStructurePublicationHead", false),
                    Set.of(WORK)));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void explicitPublicationHeadDeleteRequiresFocusEvenWhenHeadIsAbsent() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals("Work structure publication focus omitted: " + MAIN,
                publicationScopeAfterUpdate(data, MAIN, deleteUpdate(MAIN, "rv:workStructurePublicationHead", false),
                    Set.of(MAIN)));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void wildcardDeleteWithPlannedPublicationHeadAdditionRequiresPublicationFocus() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals("Work structure publication focus omitted: " + MAIN,
                publicationScopeAfterUpdate(data, MAIN, deleteUpdate(MAIN, "?predicate", true), Set.of(MAIN)));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(MAIN), p("workStructurePublicationHead"),
                uri(DECISION)));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void nativeSourceGuardPinsCurrentWorkMainStructureAndUnerasedManifest() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.READ);
        try {
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), RDF.type.asNode(),
                p("WorkStructurePublicationDecision")));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), RDF.type.asNode(),
                p("RevisionAnchor")));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), p("component"), uri(WORK)));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(),
                uri("https://schema.org/CreativeWork")));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"),
                uri(DECISION)));
            assertEquals(1, count(data, uri(CommandPolicy.REVISIONS), uri(DECISION), p("component")));
            assertEquals(1, count(data, uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead")));
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.end(); data.close(); }

        data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            data.delete(uri(CommandPolicy.REVISIONS), uri(SOURCE), p("work"), uri(WORK));
            data.add(uri(CommandPolicy.REVISIONS), uri(SOURCE), p("work"), uri(MAIN));
            assertEquals("Work structure publication source is missing or has the wrong owner: " + DECISION,
                CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.abort(); data.end(); data.close(); }

        data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.REVISIONS), uri(REVISION), RDF.type.asNode(), p("ErasedRevision"));
            assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.abort(); data.end(); data.close(); }
    }

    private static String update(String prior, String expected) {
        String priorTemplate = "?prior";
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + nt(CommandPolicy.CURRENT) + " { " + nt(WORK)
            + " rv:workStructurePublicationHead " + priorTemplate + " } } INSERT { GRAPH "
            + nt(CommandPolicy.CURRENT) + " { " + nt(WORK) + " rv:workStructurePublicationHead " + nt(DECISION)
            + " } GRAPH " + nt(CommandPolicy.REVISIONS) + " { " + nt(DECISION)
            + " a rv:WorkStructurePublicationDecision, rv:RevisionAnchor ; rv:component " + nt(WORK)
            + " ; rv:publicationOutcome rv:Published"
            + (prior == null ? "" : " ; rv:predecessor " + nt(prior)) + " } GRAPH "
            + nt(CommandPolicy.RECEIPTS) + " { " + nt(RECEIPT)
            + " a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:admissionId \"" + ADMISSION
            + "\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"work:publish:" + WORK
            + "\" ; rv:action \"work.publish\" ; rv:commandFamily \"work-structure-publication-v1\""
            + " ; rv:work " + nt(WORK) + " ; rv:publicationDecision " + nt(DECISION)
            + (expected == null ? "" : " ; rv:expectedHead " + nt(expected)) + " } } WHERE { GRAPH "
            + nt(CommandPolicy.CURRENT) + " { " + nt(WORK) + " a <https://schema.org/CreativeWork> . OPTIONAL { "
            + nt(WORK) + " rv:workStructurePublicationHead ?prior } } }";
    }

    @Test public void publicationHeadCasRejectsAConcurrentOrUnexpectedPredecessor() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            var plan = CommandPolicy.parse(update(null, null), RECEIPT);
            var snapshot = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            assertNull(HeadCasPolicy.check(data, RECEIPT, snapshot));
        } finally { data.abort(); data.end(); data.close(); }

        data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            Node prior = uri("https://rezics.com/id/00000000-0000-4000-8000-000000000008");
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"), prior);
            var plan = CommandPolicy.parse(update(prior.getURI(), null), RECEIPT);
            assertEquals("receipt expected head differs from transaction prestate",
                HeadCasPolicy.capture(data, plan, RECEIPT).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
}
