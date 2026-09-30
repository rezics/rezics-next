package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

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
            + " ; rv:language \"en\" ; rv:mainRevision " + iri(NEW_MAIN)
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
            if (replacement) data.add(NodeFactory.createURI(CommandPolicy.REVISIONS),
                NodeFactory.createURI(PRIOR), NodeFactory.createURI(RV + "language"),
                NodeFactory.createLiteralString("en"));
            CommandPolicy.Plan plan = CommandPolicy.parse(update(replacement, selectionSubject,
                receiptMainRevision, mainPredecessor), RECEIPT);
            HeadCasPolicy.Snapshot before = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            return HeadCasPolicy.check(data, RECEIPT, before);
        } finally { data.abort(); data.end(); data.close(); }
    }

    private static String multilingual(boolean replacement, boolean deleteOther, boolean duplicateLanguage) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            String other = "urn:test:chinese-head";
            UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { GRAPH " + iri(CommandPolicy.CURRENT)
                + " { " + iri(MAIN) + " rv:head " + iri(OLD_MAIN) + " ; rv:selectionHead " + iri(other)
                + (replacement ? ", " + iri(PRIOR) : "") + " } GRAPH " + iri(CommandPolicy.REVISIONS)
                + " { " + iri(other) + " rv:language \"zh-CN\" . " + iri(PRIOR) + " rv:language \"en\" . } }",
                DatasetFactory.wrap(data));
            if (duplicateLanguage) UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { GRAPH "
                + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN) + " rv:selectionHead <urn:test:duplicate> } GRAPH "
                + iri(CommandPolicy.REVISIONS) + " { <urn:test:duplicate> rv:language \"zh-cn\" } }", DatasetFactory.wrap(data));
            String text = update(replacement, MAIN, NEW_MAIN, true).replace("rv:selectionHead ?prior } } }",
                "rv:selectionHead ?prior . FILTER(?prior = " + iri(PRIOR) + ") } } }");
            CommandPolicy.Plan plan = CommandPolicy.parse(text, RECEIPT);
            HeadCasPolicy.Snapshot before = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            if (deleteOther) data.delete(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(MAIN),
                NodeFactory.createURI(RV + "selectionHead"), NodeFactory.createURI(other));
            return HeadCasPolicy.check(data, RECEIPT, before);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void perLanguageCasPreservesOtherLanguagesAndRejectsAmbiguity() {
        assertNull(multilingual(false, false, false));
        assertNull(multilingual(true, false, false));
        assertNotNull(multilingual(false, true, false));
        assertEquals("Main language heads are ambiguous", multilingual(false, false, true));
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

    private static String component(boolean wrongScope, boolean wrongRevision, boolean changedOwner) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            String work = "urn:test:work";
            UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { GRAPH " + iri(CommandPolicy.CURRENT)
                + " { " + iri(MAIN) + " rv:head " + iri(OLD_MAIN) + " ; rv:work " + iri(work)
                + " . " + iri(work) + " a <https://schema.org/CreativeWork> } }", DatasetFactory.wrap(data));
            String text = "PREFIX rv: <" + RV + "> DELETE { GRAPH " + iri(CommandPolicy.CURRENT)
                + " { " + iri(MAIN) + " rv:head " + iri(OLD_MAIN) + " } } INSERT { GRAPH "
                + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN) + " rv:head " + iri(NEW_MAIN)
                + " } GRAPH " + iri(CommandPolicy.REVISIONS) + " { " + iri(NEW_MAIN)
                + " a rv:RevisionAnchor ; rv:component " + iri(MAIN) + " ; rv:predecessor " + iri(OLD_MAIN)
                + " } GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
                + " rv:outcome rv:Succeeded ; rv:admissionId \"" + ADMISSION
                + "\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"work:edit:" + (wrongScope ? MAIN : work)
                + "\" ; rv:work " + iri(work) + " ; rv:component " + iri(MAIN)
                + " ; rv:revision " + iri(wrongRevision ? OLD_MAIN : NEW_MAIN)
                + " ; rv:expectedHead " + iri(OLD_MAIN) + " } } WHERE { GRAPH "
                + iri(CommandPolicy.CURRENT) + " { " + iri(MAIN) + " rv:head " + iri(OLD_MAIN) + " } }";
            CommandPolicy.Plan plan = CommandPolicy.parse(text, RECEIPT);
            HeadCasPolicy.Snapshot before = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            if (changedOwner) {
                data.delete(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(MAIN),
                    NodeFactory.createURI(RV + "work"), NodeFactory.createURI(work));
                data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(MAIN),
                    NodeFactory.createURI(RV + "work"), NodeFactory.createURI("urn:test:other-work"));
            }
            return HeadCasPolicy.check(data, RECEIPT, before);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void workOwnedComponentsKeepTheirIdentityScopeAndOwnerAcrossHeadCas() {
        assertNull(component(false, false, false));
        assertEquals("head transition Access scope differs from target", component(true, false, false));
        assertEquals("Work-owned component head differs from its receipt or owner", component(false, true, false));
        assertEquals("Work-owned component head differs from its receipt or owner", component(false, false, true));
    }
}
