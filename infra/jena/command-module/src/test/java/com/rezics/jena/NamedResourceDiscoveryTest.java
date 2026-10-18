package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class NamedResourceDiscoveryTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), REVISIONS=uri(CommandPolicy.REVISIONS),
        PUBLIC=uri(CommandPolicy.PUBLIC_SEARCH), NAME=uri("https://schema.org/name");
    private static void set(DatasetGraph data, Node subject, String property, Node value) {
        data.deleteAny(CURRENT,subject,p(property),Node.ANY);
        if (value != null) data.add(CURRENT,subject,p(property),value);
    }
    private static void work(DatasetGraph data, Node work, Node main) {
        data.add(CURRENT,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
        data.add(CURRENT,work,p("mainVersion"),main);
        data.add(CURRENT,main,RDF.type.asNode(),p("MainVersion"));
        data.add(CURRENT,main,p("work"),work);
        set(data,work,"catalogueVisible",NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
    }
    private static void semantic(DatasetGraph data, Node resource, Node head, Node work, String type) {
        data.add(CURRENT,resource,RDF.type.asNode(),uri(type));
        data.add(CURRENT,resource,NAME,NodeFactory.createLiteralLang("Independent named entity","en"));
        data.add(CURRENT,resource,p("semanticHead"),head);
        data.add(CURRENT,resource,p("semanticWork"),work);
        data.add(REVISIONS,head,RDF.type.asNode(),p("SemanticRevision"));
        data.add(REVISIONS,head,RDF.type.asNode(),p("RevisionAnchor"));
        data.add(REVISIONS,head,p("component"),resource);
        data.add(REVISIONS,head,p("lifecycle"),p("Active"));
        PublicNameProjection.refresh(data,resource);
    }
    private static boolean named(DatasetGraph data, Node resource) {
        return data.contains(PUBLIC,PublicNameProjection.nameUnit(resource,"resource"),p("publicTitle"),Node.ANY)
            && PublicNameProjection.visible(data,resource);
    }
    private static void repair(DatasetGraph data, String key) {
        for (int turn=0;turn<8;turn++) PublicNameProjection.repairBatch(data,"urn:test:"+key+":"+turn);
    }
    private static void changed(DatasetGraph data, Node resource, String key) {
        PublicNameProjection.refresh(data,new CommandPolicy.Plan(null,Set.of(),Set.of(resource.getURI()),Set.of(),Set.of(),false,false,true),
            "urn:test:"+key,List.of(),List.of());
    }

    @Test public void semanticNamesUseTheComponentBindingAcrossDescriptiveTypesAndParentWithdrawal() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            Node work=id(1), main=id(2);
            work(data,work,main);
            int index=10;
            for (String type:List.of("https://rezics.com/vocab/Character","https://rezics.com/vocab/Title","https://example.org/ArchiveObject")) {
                Node resource=id(index++), head=id(index++);
                semantic(data,resource,head,work,type);
                assertTrue(type,named(data,resource));
                set(data,resource,"listing",NodeFactory.createLiteralString("unlisted"));
                PublicNameProjection.refresh(data,resource);
                assertFalse(named(data,resource));
                set(data,resource,"listing",null); PublicNameProjection.refresh(data,resource);
                assertTrue(named(data,resource));
            }
            set(data,work,"catalogueVisible",null); changed(data,work,"withdraw"); repair(data,"withdraw");
            for (int resource:List.of(10,12,14)) assertFalse(named(data,id(resource)));
            work(data,work,main); changed(data,work,"restore"); repair(data,"restore");
            for (int resource:List.of(10,12,14)) assertTrue(named(data,id(resource)));
            data.add(REVISIONS,id(11),RDF.type.asNode(),p("ErasedRevision"));
            assertFalse(named(data,id(10)));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void aSemanticWorkBindingBeyondTheCandidateWindowStillEstablishesPublicDisclosure() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            Node resource=id(3), head=id(4), visibleWork=id(900), main=id(901);
            for (int index=100;index<200;index++) data.add(CURRENT,resource,p("semanticWork"),id(index));
            work(data,visibleWork,main);
            semantic(data,resource,head,visibleWork,"https://example.org/ArchiveObject");
            assertTrue(named(data,resource));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void postNamesFollowTheExactCurrentContentPublicationAndErasureFences() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            Node post=id(1), head=id(2), variant=id(3), publication=id(4), eligibility=id(5), revision=id(6);
            data.add(CURRENT,post,RDF.type.asNode(),p("Post")); set(data,post,"head",head);
            data.add(CURRENT,post,NAME,NodeFactory.createLiteralLang("A public discussion title","en"));
            data.add(CURRENT,variant,RDF.type.asNode(),p("ContentVariant")); set(data,variant,"resource",post);
            PublicNameProjection.refresh(data,post); assertFalse(named(data,post));
            set(data,variant,"contentPublicationHead",publication); set(data,variant,"publicSearchEligibilityHead",eligibility);
            data.add(REVISIONS,publication,RDF.type.asNode(),p("ContentPublicationDecision"));
            data.add(REVISIONS,publication,p("component"),variant); data.add(REVISIONS,publication,p("resource"),post);
            data.add(REVISIONS,publication,p("contentRevision"),revision);
            data.add(REVISIONS,eligibility,RDF.type.asNode(),p("ContentSearchEligibilityDecision"));
            for (var entry:java.util.Map.of("component",variant,"variant",variant,"resource",post,
                "publicationDecision",publication,"disclosure",p("Public")).entrySet())
                data.add(REVISIONS,eligibility,p(entry.getKey()),entry.getValue());
            // Publication updates the Content variant; its owner neighbour is
            // what refreshes the Post, without requiring a Post label rewrite.
            changed(data,variant,"publish"); assertTrue(named(data,post));
            set(data,variant,"contentPublicationHead",id(8)); changed(data,variant,"replace"); assertFalse(named(data,post));
            set(data,variant,"contentPublicationHead",publication); changed(data,variant,"restore"); assertTrue(named(data,post));
            data.add(REVISIONS,revision,RDF.type.asNode(),p("ErasedRevision")); assertFalse(named(data,post));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
