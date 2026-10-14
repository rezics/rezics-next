package com.rezics.jena;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class ClassificationContextUpgradeTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String CONTEXT = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String REALM = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String PRIOR = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String NEXT = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String PROFILE = "https://rezics.com/definition/classification-context-v2";
    private static final String RECEIPT = "urn:rezics:receipt:" + "ab".repeat(32);
    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static void upgrade(String defect) {
        var data = DatasetFactory.createTxnMem().asDatasetGraph();
        var profiles = ProfileRegistry.load(Files.isDirectory(Path.of("profiles"))
            ? Path.of("profiles") : Path.of("../../../generated/model"));
        data.begin(ReadWrite.WRITE);
        try {
            UpdateAction.parseExecute("""
                PREFIX rv: <https://rezics.com/vocab/>
                INSERT DATA { GRAPH <urn:rezics:graph:current> {
                  <%s> a rv:ClassificationContext ; rv:head <%s> ; rv:realm <%s> ;
                    rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
                    rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ;
                    rv:fallbackContext <urn:rezics:classification-context:global> .
                  <%s> rv:classificationContext <%s> .
                } }
                """.formatted(CONTEXT, PRIOR, REALM, REALM, CONTEXT), DatasetFactory.wrap(data));
            String update = """
                PREFIX rv: <https://rezics.com/vocab/>
                DELETE { GRAPH <urn:rezics:graph:current> { <%s> rv:head <%s> } }
                INSERT {
                  GRAPH <urn:rezics:graph:current> { <%s> rv:head <%s> ; rv:definitionProfile <%s> }
                  GRAPH <urn:rezics:graph:revisions> { <%s> a rv:RevisionAnchor ; rv:component <%s> ;
                    rv:predecessor <%s> ; rv:modelRevision <%s> ; rv:shapeRevision <%s> }
                  GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
                    rv:admissionId "00000000-0000-4000-8000-000000000005" ; rv:authorityEpoch "0" ; rv:admittedScope "%s" ;
                    rv:realm <%s> ; rv:classificationContext <%s> ; rv:contextRevision <%s> ;
                    rv:expectedHead <%s> ; rv:commandFamily "classification-context-v2" ;
                    rv:action "classification.context.configure" }
                } WHERE { GRAPH <urn:rezics:graph:current> { <%s> rv:head <%s> } }
                """.formatted(CONTEXT, PRIOR, CONTEXT, NEXT, PROFILE, NEXT, CONTEXT, PRIOR, PROFILE, PROFILE,
                    RECEIPT, "classification:context:" + (defect.equals("scope") ? CONTEXT : REALM),
                    REALM, CONTEXT, NEXT, defect.equals("expected-head") ? NEXT : PRIOR, CONTEXT, PRIOR);
            var plan = CommandPolicy.parse(update, RECEIPT);
            var model = ModelMutationPolicy.capture(profiles, data, plan);
            var heads = HeadCasPolicy.capture(data, plan, RECEIPT);
            var before = model.current().get(CONTEXT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            Node current = uri(CommandPolicy.CURRENT), context = uri(CONTEXT);
            if (defect.equals("no-head")) {
                data.delete(current, context, uri(RV + "head"), uri(NEXT));
                data.add(current, context, uri(RV + "head"), uri(PRIOR));
            } else if (defect.equals("role")) {
                data.delete(current, context, uri(RV + "contextRole"), uri(RV + "RealmClassification"));
                data.add(current, context, uri(RV + "contextRole"), uri(RV + "GlobalClassification"));
            } else if (defect.equals("selector")) {
                data.delete(current, context, uri(RV + "definitionProfile"), uri(PROFILE));
                data.add(current, context, uri(RV + "definitionProfile"), uri("urn:unreviewed:profile"));
            }
            boolean allowed = ModelMutationPolicy.classificationContextSelectionUpgrade(data, RECEIPT, CONTEXT, before);
            String headFailure = HeadCasPolicy.check(data, RECEIPT, heads, model);
            if (defect.equals("valid")) {
                assertNull(headFailure);
                assertTrue(allowed);
                assertNull(CanonicalPolicy.validate(profiles, data, CONTEXT, false));
                var upgraded = ModelMutationPolicy.capture(profiles, data, plan).current().get(CONTEXT);
                data.delete(current, context, uri(RV + "definitionProfile"), uri(PROFILE));
                assertFalse(ModelMutationPolicy.classificationContextSelectionUpgrade(data, RECEIPT, CONTEXT, upgraded));
            } else assertTrue(defect, headFailure != null || !allowed);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void legacyRealmContextSelectsItsFirstSchemeWithTheExistingHeadCas() { upgrade("valid"); }
    @Test public void selectorUpgradeCannotBypassConfigurationAuthorityOrDowngrade() {
        for (String defect : new String[] { "scope", "expected-head", "no-head", "role", "selector" }) upgrade(defect);
    }
}
