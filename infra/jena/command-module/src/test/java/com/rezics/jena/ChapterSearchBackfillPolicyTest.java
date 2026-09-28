package com.rezics.jena;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ChapterSearchBackfillPolicyTest {
    private static final String RECEIPT = "urn:rezics:receipt:chapter-search-index:" + "a".repeat(64);
    private static final String RV = "https://rezics.com/vocab/";
    private static String iri(String value) { return "<" + value + ">"; }

    private static String update(String predicate) {
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + iri(CommandPolicy.CONTROL)
            + " { <urn:rezics:dataset:product> rv:sequence ?n } } INSERT { GRAPH "
            + iri(CommandPolicy.CONTROL) + " { <urn:rezics:dataset:product> rv:sequence ?next } GRAPH "
            + iri(CommandPolicy.PUBLIC_SEARCH) + " { ?unit rv:searchResultWork ?book ;"
            + " rv:searchResultMain ?bookMain ; rv:" + predicate + " ?title . } GRAPH "
            + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
            + " a rv:OperationReceipt . } GRAPH " + iri(CommandPolicy.OUTBOX)
            + " { <urn:test:outbox> a rv:OutboxBatch . } } WHERE { BIND(1 AS ?n)"
            + " BIND(2 AS ?next) }";
    }

    @Test public void admitsOnlyTheThreeChapterIdentityPredicatesForMaintenance() {
        assertTrue(CommandPolicy.maintenanceReceipt(RECEIPT));
        CommandPolicy.parse(update("searchChapterTitle"), RECEIPT);
        assertThrows(IllegalArgumentException.class,
            () -> CommandPolicy.parse(update("searchBody"), RECEIPT));
        assertThrows(IllegalArgumentException.class,
            () -> CommandPolicy.parse(update("searchChapterTitle"),
                "urn:rezics:receipt:ordinary:" + "a".repeat(64)));
    }
}
