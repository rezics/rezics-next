package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class HeadCasPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String MAIN = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String OLD_MAIN = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String NEW_MAIN = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String PRIOR = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String SELECTION = "https://rezics.com/id/00000000-0000-4000-8000-000000000005";
    private static final String RECEIPT = "urn:rezics:receipt:head-cas-test";
    private static final String ADMISSION = "00000000-0000-4000-8000-000000000006";

    private static String iri(String value) { return "<" + value + ">"; }

    private static String update(boolean replacement, String selectionSubject,
                                 String receiptMainRevision, boolean mainPredecessor) {
        return "PREFIX rv: <" + RV + ">\n"
            + "DELETE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN)
            + " rv:selectionHead ?prior ; rv:head " + iri(OLD_MAIN) + " } }\n"
            + "INSERT { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN)
            + " rv:head " + iri(NEW_MAIN) + " . " + iri(selectionSubject)
            + " rv:selectionHead " + iri(SELECTION) + " }\n"
            + "GRAPH " + iri(CommandPolicy.REVISIONS) + " { " + iri(NEW_MAIN)
            + " a rv:RevisionAnchor ; rv:component " + iri(MAIN)
            + (mainPredecessor ? " ; rv:predecessor " + iri(OLD_MAIN) : "") + " . "
            + iri(SELECTION) + " a rv:RevisionAnchor ; rv:component " + iri(selectionSubject)
            + " ; rv:mainRevision " + iri(NEW_MAIN)
            + (replacement ? " ; rv:predecessor " + iri(PRIOR) : "") + " }\n"
            + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
            + " rv:outcome rv:Succeeded ; rv:admissionId \"" + ADMISSION
            + "\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"publication:select:" + MAIN
            + "\" ; rv:mainVersion " + iri(MAIN) + " ; rv:mainRevision "
            + iri(receiptMainRevision) + " ; rv:selection " + iri(SELECTION)
            + (replacement ? " ; rv:expectedHead " + iri(PRIOR) : "") + " } }\n"
            + "WHERE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN)
            + " rv:head " + iri(OLD_MAIN) + " . OPTIONAL { " + iri(MAIN)
            + " rv:selectionHead ?prior } } }";
    }

    private static String result(boolean replacement, String selectionSubject,
                                 String receiptMainRevision, boolean mainPredecessor) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(MAIN),
                NodeFactory.createURI(RV + "head"), NodeFactory.createURI(OLD_MAIN));
            if (replacement) data.add(NodeFactory.createURI(CommandPolicy.CURRENT),
                NodeFactory.createURI(MAIN), NodeFactory.createURI(RV + "selectionHead"),
                NodeFactory.createURI(PRIOR));
            CommandPolicy.Plan plan = CommandPolicy.parse(update(replacement, selectionSubject,
                receiptMainRevision, mainPredecessor), RECEIPT);
            HeadCasPolicy.Snapshot before = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            return HeadCasPolicy.check(data, RECEIPT, before);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void mainSelectionAdvancesBothHeadsWithExactPredecessors() {
        assertNull(result(false, MAIN, NEW_MAIN, true));
        assertNull(result(true, MAIN, NEW_MAIN, true));
    }

    @Test public void pairedHeadsRequireOneMainAndTwoMatchingRevisionAnchors() {
        assertEquals("head transition template or prestate is ambiguous",
            result(false, PRIOR, NEW_MAIN, true));
        assertEquals("head successor revision differs from prestate or component",
            result(false, MAIN, NEW_MAIN, false));
        assertEquals("Main selection paired heads differ from their receipt",
            result(false, MAIN, PRIOR, true));
    }
}
