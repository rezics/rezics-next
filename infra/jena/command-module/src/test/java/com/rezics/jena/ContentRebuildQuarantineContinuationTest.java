package com.rezics.jena;

import static org.junit.Assert.*;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** A quarantine receipt may continue a job after the public anchor is already gone. */
public class ContentRebuildQuarantineContinuationTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String HASH = "a".repeat(64);
    private static final String RECEIPT = "urn:rezics:receipt:content-rebuild:quarantine:" + HASH;

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static String update(boolean removeAnchor) {
        String anchor = removeAnchor
            ? " GRAPH <" + CommandPolicy.PUBLIC_SEARCH + "> { <" + CommandPolicy.PUBLIC_ANCHOR
                + "> a rv:SearchGraphAnchor . }"
            : "";
        return "PREFIX rv: <" + RV + "> DELETE {"
            + " GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?n }"
            + anchor + " } INSERT {"
            + " GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?next }"
            + " GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + RECEIPT + "> a rv:OperationReceipt }"
            + " GRAPH <" + CommandPolicy.OUTBOX + "> { <urn:rezics:outbox:batch> a rv:OutboxBatch } }"
            + " WHERE { GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?n }"
            + " BIND(?n + 1 AS ?next) }";
    }

    private static DatasetGraph control(boolean anchor) {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        Node control = uri(CommandPolicy.CONTROL);
        Node product = uri("urn:rezics:dataset:product");
        data.add(control, product, uri(RV + "dataEpoch"), NodeFactory.createLiteralString("epoch"));
        data.add(control, product, uri(RV + "routingEpoch"), NodeFactory.createLiteralString("routing"));
        data.add(control, product, uri(RV + "sequence"), NodeFactory.createLiteralByValue(
            java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        if (anchor) data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PUBLIC_ANCHOR),
            RDF.type.asNode(), uri(RV + "SearchGraphAnchor"));
        return data;
    }

    private static String preflight(boolean removeAnchor, boolean anchorPresent) {
        var plan = CommandPolicy.parse(update(removeAnchor), RECEIPT);
        DatasetGraph data = control(anchorPresent);
        try { return CommandInvariant.preflight(data, RECEIPT, plan); }
        finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void continuationQuarantineOmitsTheAnchorDelete() {
        var plan = CommandPolicy.parse(update(false), RECEIPT);
        assertTrue(plan.rebuild());
        assertFalse(CommandPolicy.removesPublicAnchor(plan));
        assertNull(preflight(false, false));
        assertEquals("rebuild quarantine state differs", preflight(false, true));
    }

    @Test public void liveQuarantineStillRemovesOnlyTheAnchor() {
        var plan = CommandPolicy.parse(update(true), RECEIPT);
        assertTrue(CommandPolicy.removesPublicAnchor(plan));
        assertNull(preflight(true, true));
        assertEquals("rebuild quarantine state differs", preflight(true, false));
        String extra = update(true).replace("rv:SearchGraphAnchor . }",
            "rv:SearchGraphAnchor . <urn:rezics:content:match-unit:1> rv:searchBody \"x\" . }");
        var rejected = assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(extra, RECEIPT));
        assertEquals("quarantine must remove only the public search anchor", rejected.getMessage());
    }
}
