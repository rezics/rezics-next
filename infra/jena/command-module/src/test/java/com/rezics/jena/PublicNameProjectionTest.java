package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class PublicNameProjectionTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), PUBLIC=uri(CommandPolicy.PUBLIC_SEARCH),
        LABEL=uri("http://www.w3.org/2000/01/rdf-schema#label"),
        IN_SCHEME=uri("http://www.w3.org/2004/02/skos/core#inScheme"),
        SPACE=id(1), REALM=id(2), SCHEME=id(3);
    private static Node unit(Node resource, String kind) {
        return uri(PublicNameProjection.PREFIX+kind+":"+resource.getURI().substring("https://rezics.com/id/".length()));
    }
    private static CommandPolicy.Plan plan(Node parent) {
        return new CommandPolicy.Plan(null,Set.of(),Set.of(parent.getURI()),Set.of(),Set.of(),false,false,true);
    }
    private static void refresh(DatasetGraph data, Node parent, String receipt) {
        PublicNameProjection.refresh(data,plan(parent),receipt,List.of(),List.of());
    }
    private static void set(DatasetGraph data, Node subject, String predicate, Node value) {
        data.deleteAny(CURRENT,subject,p(predicate),Node.ANY);
        if (value!=null) data.add(CURRENT,subject,p(predicate),value);
    }
    private static void space(DatasetGraph data) {
        data.add(CURRENT,SPACE,RDF.type.asNode(),p("Space"));
        data.add(CURRENT,SPACE,LABEL,NodeFactory.createLiteralLang("Lantern parent","en"));
        data.add(CURRENT,SPACE,p("disclosure"),p("Public"));
        data.add(uri(CommandPolicy.CONTROL),uri("urn:rezics:dataset:product"),p("sequence"),NodeFactory.createLiteralString("1"));
        PublicNameProjection.refresh(data,SPACE);
    }
    private static void realm(DatasetGraph data, Node resource) {
        data.add(CURRENT,resource,RDF.type.asNode(),p("Realm"));
        data.add(CURRENT,resource,p("space"),SPACE);
        data.add(CURRENT,resource,p("realmState"),p("Active"));
        PublicNameProjection.refresh(data,resource);
    }
    private static void concept(DatasetGraph data, Node resource, Node predicate, Node parent) {
        data.add(CURRENT,resource,RDF.type.asNode(),uri("http://www.w3.org/2004/02/skos/core#Concept"));
        data.add(CURRENT,resource,LABEL,NodeFactory.createLiteralLang("Lantern concept","en"));
        data.add(CURRENT,resource,p("conceptState"),p("Active"));
        data.add(CURRENT,resource,predicate,parent);
        PublicNameProjection.refresh(data,resource);
    }
    private static boolean stored(DatasetGraph data, Node resource, String kind) {
        return data.contains(PUBLIC,unit(resource,kind),p("publicTitle"),Node.ANY);
    }
    private static class Counted extends DatasetGraphWrapper {
        long probes, rows, mutations;
        Counted(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            probes++;
            if (g.equals(CURRENT) && s.equals(Node.ANY)
                && Set.of(PublicNameProjectionTest.p("space"),PublicNameProjectionTest.p("conceptRealm"),IN_SCHEME).contains(p))
                fail("parent writes must not open a dependent population iterator");
            return org.apache.jena.atlas.iterator.Iter.map(super.find(g,s,p,o), q -> { rows++; return q; });
        }
        @Override public void add(Quad q) { mutations++; super.add(q); }
        @Override public void delete(Quad q) { mutations++; super.delete(q); }
        @Override public void add(Node g,Node s,Node p,Node o) { mutations++; super.add(g,s,p,o); }
        @Override public void delete(Node g,Node s,Node p,Node o) { mutations++; super.delete(g,s,p,o); }
    }
    private static List<Long> parentWork(int population, String relation) {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            Node parent=relation.equals("space")?SPACE:relation.equals("conceptRealm")?REALM:SCHEME;
            for (int i=0;i<population;i++) {
                if (relation.equals("space")) realm(data,id(100+i));
                else concept(data,id(100+i),relation.equals("conceptRealm")?p(relation):IN_SCHEME,parent);
            }
            if (relation.equals("inScheme")) set(data,parent,"schemeState",p("Retired"));
            else set(data,parent,"listing",NodeFactory.createLiteralString("unlisted"));
            var counted=new Counted(data);
            refresh(counted,parent,"urn:receipt:parent-withdrawal");
            assertTrue(stored(data,id(100),relation.equals("space")?"realm":"concept"));
            assertFalse(PublicNameProjection.visible(data,id(100)));
            return List.of(counted.probes,counted.rows,counted.mutations);
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void parentWritesHaveConstantWorkAcrossEveryDependentPopulation() {
        for (String relation:List.of("space","conceptRealm","inScheme"))
            assertEquals(relation,parentWork(1,relation),parentWork(513,relation));
    }
    @Test public void repairResumesCommittedBatchesRollsBackInterruptionAndReplaysNoOp() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data);
            for (int i=0;i<150;i++) realm(data,id(100+i));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted"));
            refresh(data,SPACE,"urn:receipt:withdraw"); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-one"));
            assertEquals(86,storedRealms(data,150)); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-interrupted"));
            data.abort();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(86,storedRealms(data,150));
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-interrupted"));
            assertEquals(22,storedRealms(data,150));
            var counted=new Counted(data);
            assertEquals(0,PublicNameProjection.repairBatch(counted,"urn:receipt:repair-one"));
            assertEquals(0,counted.mutations);
            assertEquals(22,PublicNameProjection.repairBatch(data,"urn:receipt:repair-last"));
            assertEquals(0,storedRealms(data,150)); data.commit();
        } finally { data.end(); data.close(); }
    }
    private static int storedRealms(DatasetGraph data,int count) {
        int result=0; for (int i=0;i<count;i++) if (stored(data,id(100+i),"realm")) result++; return result;
    }
    @Test public void newerParentGenerationRestartsPendingRepairAndRestoresEveryDependent() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); for (int i=0;i<150;i++) realm(data,id(100+i));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-withdraw"));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed")); refresh(data,SPACE,"urn:receipt:restore");
            for (int i=0;i<3;i++) assertTrue(PublicNameProjection.repairBatch(data,"urn:receipt:repair-restore:"+i)<=64);
            assertEquals(150,storedRealms(data,150));
            for (int i=0;i<150;i++) assertTrue(PublicNameProjection.visible(data,id(100+i)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void cascadesUseTheExistingMaintenanceEntryPointAndRespectMovedOrDeletedDependents() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            for (int i=0;i<150;i++) concept(data,id(100+i),p("conceptRealm"),REALM);
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertFalse(PublicNameProjection.visible(data,id(100)));
            for (int i=0;i<4;i++) PublicNameProjection.refresh(data,
                new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true),
                "urn:rezics:receipt:catalogue-search-index:repair:"+i,List.of(),List.of());
            for (int i=0;i<150;i++) assertFalse(stored(data,id(100+i),"concept"));
            data.deleteAny(CURRENT,id(100),Node.ANY,Node.ANY);
            set(data,id(101),"conceptRealm",null);
            PublicNameProjection.refresh(data,id(101));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed")); refresh(data,SPACE,"urn:receipt:restore");
            for (int i=0;i<4;i++) PublicNameProjection.repairBatch(data,"urn:receipt:restore-batch:"+i);
            assertFalse(stored(data,id(100),"concept"));
            assertTrue(PublicNameProjection.visible(data,id(101)));
            for (int i=2;i<150;i++) assertTrue(PublicNameProjection.visible(data,id(100+i)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void nativeRankAndAllDirectoryOrdersFenceUnrepairedNamesAndRenamedSources() {
        var definition=new EntityDefinition("uri","label","graph"); definition.set("publicTitle",p("publicTitle"));
        definition.setLangField("lang"); definition.setUidField("uid");
        var config=new TextIndexConfig(definition); config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(DatasetGraphFactory.createTxnMem(),index,new TextDocProducerTriples(index));
        data.begin(ReadWrite.WRITE);
        try { space(data); realm(data,REALM); concept(data,id(100),p("conceptRealm"),REALM); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertTrue(PublicNameProjection.visible(data,REALM)); assertTrue(PublicNameProjection.visible(data,id(100))); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            // No capability link: the realm's stored name remains until repair.
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertTrue(stored(data,REALM,"realm")); assertTrue(stored(data,id(100),"concept")); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            for (String kind:List.of("realm","concept")) {
                var page=index.ranked(p("publicTitle"),"Lantern",64,null,data,
                    new FilteredGraphTextIndex.RankScope(null,null,null,false,kind,null));
                assertFalse(page.hits().isEmpty());
                assertTrue(page.hits().stream().allMatch(hit -> hit.key()==null));
                for (String order:List.of("identity","newest","updated")) {
                    var directory=index.directory(kind,order,64,null,data);
                    assertFalse(directory.hits().isEmpty());
                    assertTrue(directory.hits().stream().allMatch(hit -> hit.key()==null));
                }
            }
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed"));
            data.deleteAny(CURRENT,SPACE,LABEL,Node.ANY); data.add(CURRENT,SPACE,LABEL,NodeFactory.createLiteralLang("Renamed parent","en"));
            refresh(data,SPACE,"urn:receipt:rename");
            assertFalse(PublicNameProjection.visible(data,REALM));
            assertTrue(PublicNameProjection.visible(data,id(100))); // Its own label is unchanged.
            PublicNameProjection.repairBatch(data,"urn:receipt:rename-repair");
            assertTrue(PublicNameProjection.visible(data,REALM));
            assertTrue(data.contains(PUBLIC,unit(REALM,"realm"),p("publicTitle"),NodeFactory.createLiteralLang("Renamed parent","en")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void sitesRepairWhenTheirRealmWithdrawsAndRestoresWithoutASpaceMutation() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            data.add(CURRENT,SPACE,p("realmCapability"),REALM);
            Node site=id(4);
            data.add(CURRENT,site,RDF.type.asNode(),p("Zone"));
            data.add(CURRENT,site,p("space"),SPACE);
            data.add(CURRENT,site,p("zoneState"),p("Active"));
            data.add(CURRENT,site,p("disclosure"),p("Public"));
            PublicNameProjection.refresh(data,site);
            assertTrue(PublicNameProjection.visible(data,site));
            set(data,REALM,"realmState",p("Retired")); refresh(data,REALM,"urn:receipt:realm-withdraw");
            assertTrue(stored(data,site,"site")); assertFalse(PublicNameProjection.visible(data,site));
            PublicNameProjection.repairBatch(data,"urn:receipt:site-withdraw-repair");
            assertFalse(stored(data,site,"site"));
            set(data,REALM,"realmState",p("Active")); refresh(data,REALM,"urn:receipt:realm-restore");
            PublicNameProjection.repairBatch(data,"urn:receipt:site-restore-repair");
            assertTrue(PublicNameProjection.visible(data,site));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void workNameCandidatesNeverWalkThePublicationUnitPopulation() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            Node work=id(100);
            data.add(CURRENT,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
            data.add(PUBLIC,unit(work,"work"),p("resource"),work);
            var bounded=new DatasetGraphWrapper(data) {
                @Override public Iterator<Quad> find(Node g,Node s,Node predicate,Node o) {
                    if (g.equals(PUBLIC) && s.equals(Node.ANY) && predicate.equals(p("work")))
                        fail("candidate visibility must not enumerate a Work's publication units");
                    return super.find(g,s,predicate,o);
                }
            };
            assertTrue(PublicNameProjection.visible(bounded,work));
            assertTrue(PublicNameProjection.visibleUnit(bounded,unit(work,"work").getURI()));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void liveParentFenceRejectsProtectionErasureMergeAndRetirementBeforeRepair() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM); concept(data,id(100),p("conceptRealm"),REALM);
            for (Node parent:List.of(SPACE,REALM)) {
                for (String predicate:List.of("protectionHead","mergedInto")) {
                    set(data,parent,predicate,id(900)); assertFalse(PublicNameProjection.visible(data,id(100)));
                    set(data,parent,predicate,null); assertTrue(PublicNameProjection.visible(data,id(100)));
                }
                set(data,parent,"head",id(900));
                data.add(uri(CommandPolicy.REVISIONS),id(900),RDF.type.asNode(),p("ErasedRevision"));
                assertFalse(PublicNameProjection.visible(data,id(100)));
                data.deleteAny(uri(CommandPolicy.REVISIONS),id(900),Node.ANY,Node.ANY);
                assertTrue(PublicNameProjection.visible(data,id(100)));
            }
            concept(data,id(101),IN_SCHEME,SCHEME);
            set(data,SCHEME,"schemeState",p("Retired")); assertFalse(PublicNameProjection.visible(data,id(101)));
            set(data,SCHEME,"schemeState",p("Active")); assertTrue(PublicNameProjection.visible(data,id(101)));
            set(data,REALM,"realmState",p("Retired")); assertFalse(PublicNameProjection.visible(data,id(100)));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
