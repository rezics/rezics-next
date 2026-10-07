package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class StatementUpgradeTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PRODUCT = "urn:rezics:dataset:product";
    private static final String GLOBAL = "urn:rezics:classification-context:global";
    private static final String PREFIX = "urn:rezics:name-migration:statement-upgrade:";
    private static final String STATEMENT = "https://rezics.com/definition/statement-v1";
    private static final String DECISION = "https://rezics.com/definition/statement-decision-v1";
    private static final String CLASSIFICATION = "https://rezics.com/definition/classification-direct-decision-v1";
    private static final String PROPOSITION = "https://rezics.com/definition/classification-proposition-v1";
    private static final String MAIN = id(1), SENSE = id(2), DEFINITION = id(3), CONCEPT = id(4);
    private static final String ACTOR = id(5), OPERATION = id(6);
    private static final String MARKER = "urn:rezics:maintenance:statement-upgrade:" + hash("epoch");
    private static final String MEANING = "urn:rezics:meaning:" + hash("[\"statement-meaning-v1\",\"" + MAIN
        + "\",\"" + RV + "classifiedAs\",\"" + PROPOSITION + "\",[\"" + DEFINITION
        + "\"],[\"resource\",\"" + CONCEPT + "\"],[]]");
    private static final String SLOT = "urn:rezics:decision-slot:" + hash("[\"statement-decision-v1\",\"qualified-fact\",\""
        + MEANING + "\",\"" + GLOBAL + "\"]");
    private record Command(String receipt, String digest, String update) {}
    private record Source(String app, String source, String proposer, int sequence) {
        String statement() { return identity(app, MEANING); }
        String revision() { return identity(statement(), "revision"); }
        String decision() { return identity(source, "statement-decision"); }
    }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static String id(int value) { return "https://rezics.com/id/00000000-0000-0000-0000-%012d".formatted(value); }
    private static String hash(String value) { return StatementUpgradePolicy.templateDigest(value); }
    private static String identity(String source, String role) {
        String value = hash(source + '\0' + role).substring(0, 32);
        return "https://rezics.com/id/" + value.substring(0, 8) + '-' + value.substring(8, 12)
            + '-' + value.substring(12, 16) + '-' + value.substring(16, 20) + '-' + value.substring(20);
    }
    private static String graph(String graph, String facts) { return " GRAPH <" + graph + "> { " + facts + " } "; }
    private static String fence() { return "<" + PRODUCT + "> rv:restoreHold true . <" + MARKER + "> rv:statementUpgradeFence true ."; }
    private static Command command(String phase, String tag, String insert, String delete, String extra, String guards) {
        String digest = hash(tag), receipt = PREFIX + phase + ':' + digest;
        String envelope = "<" + receipt + "> a rv:OperationReceipt ; rv:commandFamily \"statement-upgrade-" + phase
            + "-v1\" ; rv:requestDigest \"" + digest + "\" ; rv:outcome rv:Succeeded ; rv:datasetId <" + PRODUCT
            + "> ; rv:dataEpoch \"epoch\" ; rv:sequence ?sequence ; rv:statementUpgrade <" + MARKER + "> . " + extra;
        String update = "PREFIX rv: <" + RV + "> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> "
            + (delete.isEmpty() ? "" : "DELETE { " + delete + " } ") + "INSERT { " + insert
            + graph(CommandPolicy.RECEIPTS, envelope) + " } WHERE { "
            + graph(CommandPolicy.CONTROL, "<" + PRODUCT + "> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"9\" ; rv:sequence ?sequence .")
            + guards + " FILTER NOT EXISTS { " + graph(CommandPolicy.RECEIPTS, "<" + receipt + "> ?p ?o") + " } }";
        return new Command(receipt, digest, update);
    }
    private static Command phase(String phase) {
        String insert = switch (phase) {
            case "acquire" -> graph(CommandPolicy.CONTROL, fence());
            case "complete" -> graph(CommandPolicy.CONTROL, "<" + MARKER + "> rv:outcome rv:Succeeded");
            default -> "";
        };
        String delete = phase.equals("release") ? graph(CommandPolicy.CONTROL, fence()) : "";
        String guards = phase.equals("acquire") ? "FILTER NOT EXISTS { " + graph(CommandPolicy.CONTROL,
            "<" + PRODUCT + "> rv:restoreHold true") + " }" : graph(CommandPolicy.CONTROL, fence()
                + (phase.equals("release") ? " <" + MARKER + "> rv:outcome rv:Succeeded ." : ""));
        return command(phase, phase, insert, delete, "", guards);
    }
    private static DatasetGraph dataset(Source... sources) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        String control = "<" + PRODUCT + "> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 99 . "
            + "<" + CommandInvariant.MAIN_STREAM_SCOPE + "> rv:dataEpoch \"epoch\" ; rv:streamSequence 7 ; rv:legacyThroughSequence 4 .";
        String current = "<" + GLOBAL + "> a rv:ClassificationContext . <" + MAIN + "> a rv:MainVersion . "
            + "<" + SENSE + "> a rv:ClassificationSense ; rv:head <" + id(100) + "> .";
        String revisions = "<" + DEFINITION + "> a rv:RevisionAnchor ; rv:component <" + SENSE
            + "> ; rv:modelRevision <" + PROPOSITION + "> ; rv:manifest <urn:rezics:sha256:" + "a".repeat(64) + "> .";
        for (Source source : sources) {
            current += "<" + source.app() + "> a rv:ClassificationApplication ; rv:applicationChannel rv:Curated ; "
                + "rv:applicationState rv:Active ; rv:targetMainVersion <" + MAIN + "> ; rv:sense <" + SENSE
                + "> ; rv:classificationContext <" + GLOBAL + "> ; rv:proposer <" + source.proposer()
                + "> ; rv:decisionHead <" + source.source() + "> .";
            revisions += "<" + source.source() + "> a rv:ClassificationDecision, rv:RevisionAnchor ; rv:component <"
                + source.app() + "> ; rv:application <" + source.app() + "> ; rv:outcome rv:Accepted ; "
                + "rv:decisionBasis rv:GlobalCuratorReview ; rv:decisionPolicy <" + CLASSIFICATION + "> ; "
                + "rv:decidedBy <" + ACTOR + "> ; rv:operation <" + OPERATION + "> ; rv:modelRevision <"
                + CLASSIFICATION + "> ; rv:manifest <urn:rezics:sha256:" + "b".repeat(64)
                + "> ; rv:dataEpoch \"historical-epoch\" ; rv:sequence " + source.sequence() + " .";
        }
        String receipts = "<urn:rezics:receipt:definition> a rv:OperationReceipt ; rv:outcome rv:Succeeded ; "
            + "rv:definitionRevision <" + DEFINITION + "> ; rv:sense <" + SENSE + "> ; rv:concept <" + CONCEPT + "> .";
        UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { " + graph(CommandPolicy.CONTROL, control)
            + graph(CommandPolicy.CURRENT, current) + graph(CommandPolicy.REVISIONS, revisions)
            + graph(CommandPolicy.RECEIPTS, receipts) + " }", DatasetFactory.wrap(data));
        data.commit(); data.end();
        return data;
    }
    private static Command conversion(Source source, String predecessor, boolean proofOnly) {
        String statement = source.statement(), revision = source.revision(), decision = source.decision();
        String current = "<" + statement + "> a rdf:Statement ; rdf:subject <" + MAIN + "> ; rdf:predicate rv:classifiedAs ; "
            + "rdf:object <" + CONCEPT + "> ; rv:relationDefinition <" + PROPOSITION + "> ; rv:interpretationDefinition <"
            + DEFINITION + "> ; rv:speaker <" + source.proposer() + "> ; rv:meaningKey <" + MEANING
            + "> ; rv:statementState rv:Active ; rv:head <" + revision + "> ; rv:migratedFrom <" + source.app() + "> . "
            + "<" + SLOT + "> a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget <" + MEANING
            + "> ; rv:acceptanceContext <" + GLOBAL + "> ; rv:decisionHead <" + decision + "> .";
        String revisions = "<" + revision + "> a rv:StatementRevision, rv:RevisionAnchor ; rv:component <" + statement
            + "> ; rv:statementState rv:Active ; rv:recordedBy <" + ACTOR + "> ; " + anchor(STATEMENT, source.sequence()) + " . "
            + "<" + decision + "> a rv:StatementDecision, rv:RevisionAnchor ; rv:component <" + SLOT
            + "> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <" + ACTOR
            + "> ; rv:decisionPolicy <" + DECISION + "> ; rv:support <" + statement + "> ; rv:convertedFrom <"
            + source.source() + "> ; " + (predecessor == null ? "" : "rv:predecessor <" + predecessor + "> ; ")
            + anchor(DECISION, source.sequence()) + " .";
        String digest = hash(source.app() + (proofOnly ? "-proof" : ""));
        String receipt = PREFIX + "convert:" + digest;
        String metadata = "<" + receipt + "> rv:convertedApplication <" + source.app() + "> ; rv:convertedDecision <"
            + source.source() + "> ; rv:statement <" + statement + "> ; rv:statementRevision <" + revision
            + "> ; rv:decisionSlot <" + SLOT + "> ; rv:statementDecision <" + decision + "> .";
        String guards = graph(CommandPolicy.CONTROL, fence()) + graph(CommandPolicy.CURRENT,
            "<" + source.app() + "> rv:decisionHead <" + source.source() + "> ."
            + (!proofOnly && predecessor != null ? " <" + SLOT + "> rv:decisionHead <" + predecessor + "> ." : ""));
        return command("convert", source.app() + (proofOnly ? "-proof" : ""), proofOnly ? "" : graph(CommandPolicy.CURRENT, current)
            + graph(CommandPolicy.REVISIONS, revisions), proofOnly || predecessor == null ? ""
            : graph(CommandPolicy.CURRENT, "<" + SLOT + "> rv:decisionHead <" + predecessor + ">"), metadata, guards);
    }
    private static String anchor(String profile, int sequence) {
        return "rv:operation <" + OPERATION + "> ; rv:modelRevision <" + profile + "> ; rv:shapeRevision <" + profile
            + "> ; rv:manifest <urn:rezics:sha256:" + "c".repeat(64) + "> ; rv:dataEpoch \"historical-epoch\" ; rv:sequence " + sequence;
    }
    private static CommandService service() {
        return new CommandService(ProfileRegistry.load(Path.of("src/test/resources/registry-probe")),
            "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> run(CommandService service, DatasetGraph data, Command command) throws Exception {
        Method run = CommandService.class.getDeclaredMethod("run", DatasetGraph.class, String.class, String.class, String.class,
            JsonValue.class, CommandPolicy.Plan.class, List.class, long.class);
        run.setAccessible(true);
        try (var work = new CommandWork()) {
            return (Map<String, Object>) run.invoke(service, data, command.receipt(), command.digest(), command.update(), null,
                CommandPolicy.parse(command.update(), command.receipt()), List.of(), System.nanoTime() + 10_000_000_000L);
        }
    }
    private static void apply(DatasetGraph data, Command command) {
        var plan = CommandPolicy.parse(command.update(), command.receipt());
        var before = CommandInvariant.readControl(data);
        var snapshot = StatementUpgradePolicy.capture(data, command.receipt(), command.digest(), plan);
        assertNull(snapshot.error());
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
        assertNull(CommandInvariant.check(data, command.receipt(), command.digest(), plan, before));
        assertNull(StatementUpgradePolicy.check(data, snapshot));
        assertNull(CommandInvariant.advanceRelayStream(data, command.receipt(), plan, before));
    }
    private static Set<Quad> record(DatasetGraph data, String graph, String subject) {
        Set<Quad> result = new HashSet<>();
        data.find(uri(graph), uri(subject), Node.ANY, Node.ANY).forEachRemaining(result::add);
        return result;
    }

    @Test public void phaseTransactionsPreserveBothPositionsAndReplayOnlyExactTemplates() throws Exception {
        DatasetGraph data = dataset();
        try {
            var service = service();
            for (String phase : List.of("acquire", "complete", "release")) {
                Command command = phase(phase);
                assertTrue(CommandPolicy.maintenanceReceipt(command.receipt()));
                assertEquals("committed", run(service, data, command).get("status"));
                assertEquals("committed", run(service, data, command).get("status"));
                Command altered = new Command(command.receipt(), command.digest(), command.update() + "\n");
                assertEquals("conflict", run(service, data, altered).get("status"));
            }
            data.begin(ReadWrite.READ);
            assertEquals("99", CommandInvariant.readControl(data).sequence().toString());
            assertFalse(CommandInvariant.readControl(data).held());
            assertEquals("7", data.find(uri(CommandPolicy.CONTROL), uri(CommandInvariant.MAIN_STREAM_SCOPE),
                uri(RV + "streamSequence"), Node.ANY).next().getObject().getLiteralLexicalForm());
            assertFalse(data.contains(uri(CommandPolicy.OUTBOX), Node.ANY, Node.ANY, Node.ANY));
            data.end();
        } finally { if (data.isInTransaction()) data.end(); data.close(); }
    }

    @Test public void unrelatedFenceWrongRoutingAndPrematureReleaseAreDenied() throws Exception {
        DatasetGraph data = dataset();
        try {
            assertEquals("invalid", run(service(), data, phase("release")).get("status"));
            Command acquire = phase("acquire");
            Command wrong = new Command(acquire.receipt(), acquire.digest(), acquire.update().replace("rv:routingEpoch \"9\"", "rv:routingEpoch \"8\""));
            assertEquals("invalid", run(service(), data, wrong).get("status"));
            data.begin(ReadWrite.WRITE);
            UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { " + graph(CommandPolicy.CONTROL,
                "<" + PRODUCT + "> rv:restoreHold true . <urn:unrelated> rv:statementUpgradeFence true") + " }", DatasetFactory.wrap(data));
            data.commit(); data.end();
            assertEquals("invalid", run(service(), data, acquire).get("status"));
            assertEquals("invalid", run(service(), data, phase("complete")).get("status"));
            data.begin(ReadWrite.READ);
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS), uri(acquire.receipt()), Node.ANY, Node.ANY));
            data.end();
        } finally { if (data.isInTransaction()) data.end(); data.close(); }
    }

    @Test public void upgradeNamespaceCannotCarryArbitraryMaintenanceOrRestoreWrites() {
        Command acquire = phase("acquire");
        for (String extra : List.of("<" + PRODUCT + "> rv:sequence 0 .", "<" + PRODUCT + "> rv:restoreCutover <urn:cutover> .",
            "<urn:unrelated> rv:statementUpgradeFence true .", "<" + PRODUCT + "> rv:dataEpoch \"new\" .")) {
            String altered = acquire.update().replace(fence(), fence() + extra);
            assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(altered, acquire.receipt()));
        }
        String arbitrary = acquire.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.CURRENT, "<urn:unrelated> a rv:Agent"));
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(arbitrary, acquire.receipt()));
        String stream = acquire.update().replace(fence(), fence() + "<" + CommandInvariant.MAIN_STREAM_SCOPE + "> rv:streamSequence 0 .");
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(stream, acquire.receipt()));
        String malformed = acquire.receipt().replace("acquire:", "other:");
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(acquire.update().replace(acquire.receipt(), malformed), malformed));
    }

    @Test public void populatedSameMeaningDecisionsCasSharedSlotAndPreserveEveryHistoricalRecord() {
        Source first = new Source(id(11), id(21), id(31), 4), second = new Source(id(12), id(22), id(32), 8);
        DatasetGraph data = dataset(first, second);
        data.begin(ReadWrite.WRITE);
        try {
            Set<Quad> firstRaw = record(data, CommandPolicy.REVISIONS, first.source());
            Set<Quad> secondRaw = record(data, CommandPolicy.REVISIONS, second.source());
            Set<Quad> firstApp = record(data, CommandPolicy.CURRENT, first.app());
            apply(data, phase("acquire"));
            apply(data, conversion(first, null, false));
            apply(data, conversion(second, first.decision(), false));
            assertEquals(firstRaw, record(data, CommandPolicy.REVISIONS, first.source()));
            assertEquals(secondRaw, record(data, CommandPolicy.REVISIONS, second.source()));
            assertEquals(firstApp, record(data, CommandPolicy.CURRENT, first.app()));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(SLOT), uri(RV + "decisionHead"), uri(second.decision())));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(SLOT), uri(RV + "decisionHead"), uri(first.decision())));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(second.decision()), uri(RV + "predecessor"), uri(first.decision())));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(first.statement()), uri(RV + "speaker"), uri(first.proposer())));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(second.statement()), uri(RV + "speaker"), uri(second.proposer())));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(first.revision()), uri(RV + "dataEpoch"), NodeFactory.createLiteralString("historical-epoch")));
            assertEquals("99", CommandInvariant.readControl(data).sequence().toString());
            apply(data, conversion(first, null, true));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(SLOT), uri(RV + "decisionHead"), uri(second.decision())));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void conversionRejectsMissingCasWrongProvenanceAndRewritingRetainedHistory() {
        Source first = new Source(id(11), id(21), id(31), 4), second = new Source(id(12), id(22), id(32), 8);
        DatasetGraph data = dataset(first, second);
        data.begin(ReadWrite.WRITE);
        try {
            apply(data, phase("acquire"));
            apply(data, conversion(first, null, false));
            Command proof = conversion(first, null, true);
            String proofDelete = proof.update().replace("INSERT {", "DELETE { " + graph(CommandPolicy.CURRENT,
                "<" + SLOT + "> rv:decisionHead <" + first.decision() + ">") + " } INSERT {");
            assertEquals("proof-only Statement conversion cannot delete data", StatementUpgradePolicy.capture(data,
                proof.receipt(), proof.digest(), CommandPolicy.parse(proofDelete, proof.receipt())).error());
            Command absentCas = conversion(second, null, false);
            assertNotNull(StatementUpgradePolicy.capture(data, absentCas.receipt(), absentCas.digest(),
                CommandPolicy.parse(absentCas.update(), absentCas.receipt())).error());
            Command valid = conversion(second, first.decision(), false);
            for (String altered : List.of(
                valid.update().replace("rv:dataEpoch \"historical-epoch\"", "rv:dataEpoch \"epoch\""),
                valid.update().replace("rv:recordedBy <" + ACTOR + ">", "rv:recordedBy <" + id(88) + ">"),
                valid.update().replace("rv:convertedFrom <" + second.source() + ">", "rv:convertedFrom <" + first.source() + ">"),
                valid.update().replace("rv:speaker <" + second.proposer() + ">", "rv:speaker <" + first.proposer() + ">"),
                valid.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.REVISIONS,
                    "<" + first.source() + "> rv:decisionHead <" + id(77) + "> .")))) {
                var plan = CommandPolicy.parse(altered, valid.receipt());
                assertNotNull(StatementUpgradePolicy.capture(data, valid.receipt(), valid.digest(), plan).error());
            }
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS), uri(valid.receipt()), Node.ANY, Node.ANY));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void retirementWritesOnlyAnAbsentHashBoundUnavailableCancellation() throws Exception {
        String admission = "00000000-0000-0000-0000-000000000099", family = "statement-migrate-v1";
        String retired = "urn:rezics:receipt:" + hash(admission + '\0' + family);
        String receipt = PREFIX + "retire:" + hash("retired");
        String extra = "<" + receipt + "> rv:retiredReceipt <" + retired + "> . <" + retired
            + "> a rv:OperationReceipt ; rv:commandFamily \"" + family + "\" ; rv:requestDigest \"" + "f".repeat(64)
            + "\" ; rv:admissionId \"" + admission + "\" ; rv:authorityEpoch \"3\" ; rv:admittedScope \"statement:migrate\" ; "
            + "rv:outcome rv:Cancelled ; rv:reason rv:Unavailable ; rv:datasetId <" + PRODUCT
            + "> ; rv:dataEpoch \"epoch\" ; rv:sequence ?sequence .";
        Command retire = command("retire", "retired", "", "", extra, "");
        DatasetGraph data = dataset();
        try {
            assertEquals("committed", run(service(), data, retire).get("status"));
            assertEquals("committed", run(service(), data, retire).get("status"));
            Command duplicate = command("retire", "retired-again", "", "", extra.replace(receipt,
                PREFIX + "retire:" + hash("retired-again")), "");
            assertEquals("invalid", run(service(), data, duplicate).get("status"));
            String forged = retire.update().replace("statement-migrate-v1", "statement-record-v1");
            assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(forged, retire.receipt()));
            data.begin(ReadWrite.READ);
            assertTrue(data.contains(uri(CommandPolicy.RECEIPTS), uri(retired), uri(RV + "outcome"), uri(RV + "Cancelled")));
            assertEquals("99", CommandInvariant.readControl(data).sequence().toString());
            data.end();
        } finally { if (data.isInTransaction()) data.end(); data.close(); }
    }
}
