package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class CommandInvariantRelayStreamTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PRODUCT = "urn:rezics:dataset:product";
    private static final String RECEIPT = "urn:rezics:receipt:relay-test";
    private static final String BATCH = "urn:rezics:outbox:relay-test";

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static String value(DatasetGraph data, String subject, String predicate) {
        return data.find(uri(CommandPolicy.CONTROL), uri(subject), uri(RV + predicate), Node.ANY)
            .next().getObject().getLiteralLexicalForm();
    }
    private static String envelope() {
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH <" + CommandPolicy.CONTROL + "> { <"
            + PRODUCT + "> rv:sequence ?n } } INSERT { GRAPH <" + CommandPolicy.CONTROL + "> { <"
            + PRODUCT + "> rv:sequence ?next } GRAPH <" + CommandPolicy.RECEIPTS + "> { <"
            + RECEIPT + "> a rv:OperationReceipt ; rv:requestDigest \"test\" ; rv:datasetId <"
            + PRODUCT + "> ; rv:dataEpoch \"epoch\" ; rv:sequence ?next ; rv:outcome rv:Cancelled }"
            + " GRAPH <" + CommandPolicy.OUTBOX + "> { <" + BATCH
            + "> a rv:OutboxBatch ; rv:dataEpoch \"epoch\" ; rv:sequence ?next ; rv:eventCount 0 } }"
            + " WHERE { GRAPH <" + CommandPolicy.CONTROL + "> { <" + PRODUCT
            + "> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"1\" ; rv:sequence ?n } BIND(?n + 1 AS ?next) }";
    }
    private static void control(DatasetGraph data, int sequence) {
        UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { GRAPH <" + CommandPolicy.CONTROL
            + "> { <" + PRODUCT + "> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"1\" ; rv:sequence "
            + sequence + " } }", DatasetFactory.wrap(data));
    }

    @Test public void relayCounterAdvancesIndependentlyAndIncludesZeroEventBatches() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            control(data, 900);
            UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { GRAPH <" + CommandPolicy.CONTROL
                + "> { <" + CommandInvariant.MAIN_STREAM_SCOPE
                + "> rv:dataEpoch \"epoch\" ; rv:streamSequence 2 ; rv:legacyThroughSequence 0 } }",
                DatasetFactory.wrap(data));
            var before = CommandInvariant.readControl(data);
            var plan = CommandPolicy.parse(envelope(), RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            assertNull(CommandInvariant.check(data, RECEIPT, "test", plan, before));
            assertNull(CommandInvariant.advanceRelayStream(data, RECEIPT, plan, before));
            assertEquals("901", value(data, PRODUCT, "sequence"));
            assertEquals("3", value(data, CommandInvariant.MAIN_STREAM_SCOPE, "streamSequence"));
            assertEquals("3", data.find(uri(CommandPolicy.OUTBOX), uri(BATCH), uri(RV + "streamSequence"), Node.ANY)
                .next().getObject().getLiteralLexicalForm());
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void populatedLegacyPrefixIsSeededOnceWithoutRewritingBatches() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            control(data, 17);
            var before = CommandInvariant.readControl(data);
            var plan = CommandPolicy.parse(envelope(), RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            assertNull(CommandInvariant.advanceRelayStream(data, RECEIPT, plan, before));
            assertEquals("17", value(data, CommandInvariant.MAIN_STREAM_SCOPE, "legacyThroughSequence"));
            assertEquals("18", value(data, CommandInvariant.MAIN_STREAM_SCOPE, "streamSequence"));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void callerCannotForgeStreamWatermarksOrBatchScope() {
        for (String field : new String[] { "streamScope", "streamSequence", "legacyThroughSequence" }) {
            String forged = envelope().replace("rv:eventCount 0", "rv:eventCount 0 ; rv:" + field + " 9");
            assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(forged, RECEIPT));
        }
        String variable = envelope().replace("rv:eventCount 0", "rv:eventCount 0 ; ?predicate ?value");
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(variable, RECEIPT));
        for (String triple : new String[] {
            "<" + CommandInvariant.MAIN_STREAM_SCOPE + "> rv:dataEpoch \"epoch\"",
            "<" + CommandInvariant.MAIN_STREAM_SCOPE + "> ?predicate ?value",
            "?subject rv:dataEpoch \"epoch\""
        }) {
            String forged = envelope().replace("rv:sequence ?next } GRAPH",
                "rv:sequence ?next . " + triple + " } GRAPH");
            assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(forged, RECEIPT));
        }
    }
}
