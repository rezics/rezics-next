package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Direct policy qualification; held native Core integration is a separate manager patch. */
public class ClaimStatementFoldTest {
    private static final String RV="https://rezics.com/vocab/", XSD="http://www.w3.org/2001/XMLSchema#",
        FAMILY="claim-statement-fold-v1", PREFIX="urn:rezics:name-migration:claim-statement-fold:",
        CLAIM_PROFILE="https://rezics.com/definition/claim-v1", STATEMENT_PROFILE="https://rezics.com/definition/statement-v1",
        DEFINITION_PROFILE="https://rezics.com/definition/semantic-definition-v1", P="https://schema.org/datePublished",
        CURRENT_EPOCH="current-epoch", ROUTING="9", SOURCE_EPOCH="source-epoch", JOB="reviewed-publication-dates",
        ADMISSION="00000000-0000-4000-8000-000000000050";
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), REVISIONS=uri(CommandPolicy.REVISIONS),
        CONTROL=uri(CommandPolicy.CONTROL), RECEIPTS=uri(CommandPolicy.RECEIPTS), OUTBOX=uri(CommandPolicy.OUTBOX),
        PRODUCT=uri("urn:rezics:dataset:product"), C=id(1), R=id(2), A=id(3), O=id(4),
        D=id(10), Q=id(11), DC=id(12), QC=id(13), MODEL=id(14),
        S=uri("urn:retained:book:volume-one"), K=uri("urn:retained:interpretation:publication"),
        EDITION=uri("urn:retained:edition:first"), DERIVATION=uri("urn:retained:evidence:source"),
        ORIGINAL=uri("urn:rezics:receipt:"+hash(ADMISSION+'\0'+"claim-create"));
    private static final ProfileRegistry PROFILES=ProfileRegistry.load(Path.of("profiles"));
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV+value); }
    private static Node id(int value) { return uri("https://rezics.com/id/00000000-0000-4000-8000-%012d".formatted(value)); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node typed(String lexical,String type) { return NodeFactory.createLiteralDT(lexical,
        org.apache.jena.datatypes.TypeMapper.getInstance().getSafeTypeByName(type)); }
    private static Node integer(int value) { return typed(Integer.toString(value),XSD+"integer"); }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch(Exception error) { throw new AssertionError(error); }
    }
    private static Map<String,Object> object(Object... entries) {
        Map<String,Object> result=new LinkedHashMap<>();
        for(int i=0;i<entries.length;i+=2) result.put((String)entries[i],entries[i+1]);
        return result;
    }
    /** Match JSON.stringify bytes independently of the native policy's codec. */
    private static String json(Object value) {
        if(value==null) return "null";
        if(value instanceof String string) return org.apache.jena.atlas.json.JSON.toStringFlat(new org.apache.jena.atlas.json.JsonString(string));
        if(value instanceof List<?> list) return "["+list.stream().map(ClaimStatementFoldTest::json).collect(java.util.stream.Collectors.joining(","))+"]";
        if(value instanceof Map<?,?> map) return "{"+map.entrySet().stream().map(entry->json(entry.getKey())+":"+json(entry.getValue()))
            .collect(java.util.stream.Collectors.joining(","))+"}";
        return value.toString();
    }
    private record Sealed(String manifest,String payload,String iri) {}
    private static Sealed seal(Node component,String profile,Map<String,Object> state) {
        String payload=json(object("format","rezics-component-v1","component",component.getURI(),"state",state));
        return sealPayload(component,profile,payload);
    }
    private static Sealed sealPayload(Node component,String profile,String payload) {
        String manifest=json(object("format","rezics-manifest-v1","component",component.getURI(),"payload","sha256:"+hash(payload),
            "payloadBytes",payload.getBytes(StandardCharsets.UTF_8).length,"mediaType","application/json","model",profile,"shape",profile));
        return new Sealed(manifest,payload,"urn:rezics:sha256:"+hash(manifest));
    }
    private static Sealed definition(Node component,String kind,String notation) {
        return seal(component,DEFINITION_PROFILE,object("component","definition","kind",kind,"lifecycle","active",
            "successor",null,"roles",List.of(),"notation",notation));
    }
    private record Fixture(DatasetGraph data,Sealed relation,Sealed qualification,Node value) implements AutoCloseable {
        @Override public void close() { data.close(); }
    }
    private static void add(DatasetGraph data,Node graph,Node subject,Object... fields) {
        for(int i=0;i<fields.length;i+=2) data.add(graph,subject,(Node)fields[i],(Node)fields[i+1]);
    }
    private static Fixture fixture(int assessments,int unrelated,Node value) {
        DatasetGraph data=TDB2Factory.createDataset().asDatasetGraph();
        Sealed relation=definition(DC,"property","statement-first-publication-date-v1"),
            qualification=definition(QC,"interpretation","statement-proposition-qualification-v1");
        data.begin(ReadWrite.WRITE);
        try {
            add(data,CONTROL,PRODUCT,p("dataEpoch"),text(CURRENT_EPOCH),p("routingEpoch"),text(ROUTING),p("sequence"),integer(100));
            add(data,CONTROL,uri(CommandInvariant.MAIN_STREAM_SCOPE),p("dataEpoch"),text(CURRENT_EPOCH),p("streamSequence"),integer(7),p("legacyThroughSequence"),integer(4));
            add(data,CURRENT,C,RDF.type.asNode(),p("Claim"),p("referent"),S,p("interpretationContext"),K,
                p("propositionPredicate"),uri(P),p("claimHead"),R,p("claimState"),p("Active"));
            add(data,REVISIONS,R,RDF.type.asNode(),p("ClaimRevision"),RDF.type.asNode(),p("RevisionAnchor"),p("component"),C,
                p("referent"),S,p("interpretationContext"),K,p("propositionPredicate"),uri(P),p("propositionValue"),value,
                p("valuePrecision"),p("ApproximateValue"),p("valueQualifier"),p("DisputedAttribution"),p("valueQualifier"),p("InferredValue"),
                p("validFrom"),typed("2000-01-01T00:00:00Z",XSD+"dateTime"),p("validUntil"),typed("2030-01-01T00:00:00Z",XSD+"dateTime"),
                p("editionScope"),EDITION,p("claimStatus"),p("Asserted"),p("derivation"),DERIVATION,p("statedBy"),A,
                p("recordedAt"),typed("2021-02-03T04:05:06.123Z",XSD+"dateTime"),p("modelRevision"),uri(CLAIM_PROFILE),
                p("shapeRevision"),uri(CLAIM_PROFILE),p("dataEpoch"),text(SOURCE_EPOCH),p("sequence"),integer(2));
            add(data,RECEIPTS,ORIGINAL,RDF.type.asNode(),p("OperationReceipt"),p("outcome"),p("Succeeded"),p("claim"),C,p("claimRevision"),R,
                p("operation"),O,p("admissionId"),text(ADMISSION),p("requestDigest"),text("a".repeat(64)),p("authorityEpoch"),text("3"),
                p("admittedScope"),text("verification:claim:global"),p("datasetId"),PRODUCT,p("dataEpoch"),text(SOURCE_EPOCH),p("sequence"),integer(2));
            add(data,OUTBOX,uri("urn:retained:claim-create:batch"),RDF.type.asNode(),p("OutboxBatch"),p("dataEpoch"),text(SOURCE_EPOCH),
                p("sequence"),integer(2),p("eventCount"),integer(1),p("event"),uri("urn:retained:claim-create:event"));
            add(data,OUTBOX,uri("urn:retained:claim-create:event"),RDF.type.asNode(),p("ClaimCreatedEvent"),p("ordinal"),integer(0),
                p("receipt"),ORIGINAL,p("action"),text("verification.claim-create"),p("operation"),O);
            add(data,REVISIONS,MODEL,RDF.type.asNode(),p("ModelGeneration"));
            definitionFacts(data,DC,D,p("PropertyDefinition"),relation);
            definitionFacts(data,QC,Q,p("InterpretationDefinition"),qualification);
            for(int i=0;i<assessments;i++) add(data,REVISIONS,id(1000+i),RDF.type.asNode(),p("ClaimAssessmentRevision"),
                RDF.type.asNode(),p("RevisionAnchor"),p("component"),C,p("targetRevision"),R,p("evidence"),uri("urn:retained:evidence:"+i));
            for(int i=0;i<unrelated;i++) add(data,REVISIONS,id(10000+i),RDF.type.asNode(),p("ClaimRevision"),p("component"),id(20000+i),
                p("payload"),text("unrelated "+i));
            data.commit();
        } finally { data.end(); }
        return new Fixture(data,relation,qualification,value);
    }
    private static void definitionFacts(DatasetGraph data,Node component,Node revision,Node kind,Sealed bytes) {
        add(data,CURRENT,component,RDF.type.asNode(),p("SemanticDefinition"),p("definitionKind"),kind,p("definitionHead"),revision);
        add(data,REVISIONS,revision,RDF.type.asNode(),p("DefinitionRevision"),RDF.type.asNode(),p("RevisionAnchor"),p("component"),component,
            p("definitionKind"),kind,p("lifecycle"),p("Active"),p("manifest"),uri(bytes.iri()),p("operation"),O,p("modelGeneration"),MODEL,
            p("modelRevision"),uri(DEFINITION_PROFILE),p("shapeRevision"),uri(DEFINITION_PROFILE),p("datasetId"),PRODUCT,
            p("dataEpoch"),text(SOURCE_EPOCH),p("sequence"),integer(1));
    }
    private static Set<Quad> record(DatasetGraph data,Node graph,Node subject) { return new HashSet<>(Iter.toList(data.find(graph,subject,Node.ANY,Node.ANY))); }
    private static Set<Quad> all(DatasetGraph data) {
        data.begin(ReadWrite.READ); try { return new HashSet<>(Iter.toList(data.find())); } finally { data.end(); }
    }
    private static Node one(DatasetGraph data,Node graph,Node subject,Node predicate) {
        var rows=data.find(graph,subject,predicate,Node.ANY);
        try { assertTrue(rows.hasNext()); Node value=rows.next().getObject(); assertFalse(rows.hasNext()); return value; }
        finally { Iter.close(rows); }
    }
    private static List<Object> termIdentity(Node node) {
        return Arrays.asList(node.isURI()?"uri":"literal",node.isURI()?node.getURI():node.getLiteralLexicalForm(),
            node.isLiteral()?node.getLiteralDatatypeURI():null,node.isLiteral()&&!node.getLiteralLanguage().isEmpty()?node.getLiteralLanguage():null);
    }
    private static List<Object> properties(Set<Quad> quads) {
        return quads.stream().sorted(Comparator.comparing((Quad quad)->quad.getPredicate().getURI()).thenComparing(quad->json(termIdentity(quad.getObject()))))
            .map(quad->(Object)Arrays.asList(quad.getPredicate().getURI(),termIdentity(quad.getObject()))).toList();
    }
    private static String triples(Set<Quad> quads) {
        return quads.stream().sorted(Comparator.comparing(Quad::toString)).map(quad->NodeFmtLib.strNT(quad.getSubject())+" "+NodeFmtLib.strNT(quad.getPredicate())
            +" "+NodeFmtLib.strNT(quad.getObject())+" .").collect(java.util.stream.Collectors.joining("\n"));
    }
    private static String graph(Node graph,String triples) { return " GRAPH <"+graph.getURI()+"> { "+triples+" } "; }
    private static String mapDigest() { return hash(json(List.of(FAMILY,P,D.getURI(),Q.getURI()))); }
    private static Map<String,Object> fence() { return object("marker","urn:rezics:maintenance:claim-statement-fold:"+hash(json(List.of(CURRENT_EPOCH,ROUTING,mapDigest(),JOB))),"mapDigest",mapDigest(),"job",JOB); }
    private static Node marker() { return uri((String)fence().get("marker")); }
    private record Command(String phase,String receipt,String digest,String update,Node revision) {
        Command changed(String update) { return new Command(phase,receipt,digest,update,revision); }
    }
    private static String controlGuard() { return NodeFmtLib.strNT(PRODUCT)+" <"+RV+"dataEpoch> "+NodeFmtLib.strNT(text(CURRENT_EPOCH))
        +" ; <"+RV+"routingEpoch> "+NodeFmtLib.strNT(text(ROUTING))+" ; <"+RV+"sequence> ?sequence ."; }
    private static String ownedGuard() { return NodeFmtLib.strNT(PRODUCT)+" <"+RV+"restoreHold> true . "+NodeFmtLib.strNT(marker())
        +" <"+RV+"claimStatementFoldFence> true ; <"+RV+"foldMapDigest> "+NodeFmtLib.strNT(text(mapDigest()))+" ."; }
    private static Command command(String phase,List<String> identities,String currentDelete,String currentInsert,String revisionInsert,String extras,String guards,Node revision) {
        List<Object> identity=new ArrayList<>(List.of(FAMILY,phase,CURRENT_EPOCH,ROUTING,fence())); identity.addAll(identities);
        String digest=hash(json(identity)), receipt=PREFIX+phase+":"+digest;
        String receiptFacts="<"+receipt+"> a rv:OperationReceipt ; rv:commandFamily "+NodeFmtLib.strNT(text("claim-statement-fold-"+phase+"-v1"))
            +" ; rv:requestDigest "+NodeFmtLib.strNT(text(digest))+" ; rv:outcome rv:Succeeded ; rv:datasetId <"+PRODUCT.getURI()+"> ; rv:dataEpoch "
            +NodeFmtLib.strNT(text(CURRENT_EPOCH))+" ; rv:sequence ?sequence ; rv:claimStatementFold <"+marker().getURI()+"> ; rv:foldMapDigest "
            +NodeFmtLib.strNT(text(mapDigest()))+" ; rv:claimFoldJob "+NodeFmtLib.strNT(text(JOB))+" . "+extras.replace("$RECEIPT",receipt);
        String controlInsert=phase.equals("acquire")?ownedGuard():phase.equals("complete")?"<"+marker().getURI()+"> rv:outcome rv:Succeeded .":"";
        String controlDelete=phase.equals("release")?ownedGuard():"";
        String update="PREFIX rv: <"+RV+"> DELETE { "+(currentDelete.isEmpty()?"":graph(CURRENT,currentDelete))
            +(controlDelete.isEmpty()?"":graph(CONTROL,controlDelete))+" } INSERT { "
            +(currentInsert.isEmpty()?"":graph(CURRENT,currentInsert))+(revisionInsert.isEmpty()?"":graph(REVISIONS,revisionInsert))
            +(controlInsert.isEmpty()?"":graph(CONTROL,controlInsert))+graph(RECEIPTS,receiptFacts)+" } WHERE { "
            +graph(CONTROL,controlGuard()+(phase.equals("acquire")?"":ownedGuard()))+guards
            +" FILTER NOT EXISTS { "+graph(RECEIPTS,"<"+receipt+"> ?rp ?ro")+" } }";
        return new Command(phase,receipt,digest,update,revision);
    }
    private static Command acquire() { return command("acquire",List.of(),"","","","",
        "FILTER NOT EXISTS { "+graph(CONTROL,"<"+PRODUCT.getURI()+"> rv:restoreHold true")+" }",null); }
    private static Map<String,Object> meaning(Node value) {
        return object("subject",S.getURI(),"applicability",List.of(),"predicate",P,"relationDefinition",D.getURI(),"interpretationDefinitions",List.of(Q.getURI()),
            "value",object("kind","literal","lexical",value.getLiteralLexicalForm(),"datatype",value.getLiteralDatatypeURI(),"language",null),
            "qualification",object("definition",Q.getURI(),"interpretationContext",K.getURI(),"valuePrecision","approximate",
                "valueQualifiers",List.of("disputed-attribution","inferred"),"validFrom","2000-01-01T00:00:00Z","validUntil","2030-01-01T00:00:00Z","editionScope",EDITION.getURI()),
            "referenceDomain","retained-claim");
    }
    private static String meaningKey(Node value) {
        return "urn:rezics:meaning:"+hash(json(Arrays.asList("statement-meaning-v2",S.getURI(),P,D.getURI(),List.of(Q.getURI()),
            Arrays.asList("literal",value.getLiteralLexicalForm(),value.getLiteralDatatypeURI(),null),List.of(),
            Arrays.asList(Q.getURI(),K.getURI(),"approximate",List.of("disputed-attribution","inferred"),"2000-01-01T00:00:00.000Z","2030-01-01T00:00:00.000Z",EDITION.getURI()))));
    }
    private static Command conversion(Fixture fixture) {
        return conversion(fixture,null);
    }
    private static Command conversion(Fixture fixture,String suppliedSourceDigest) {
        DatasetGraph data=fixture.data(); data.begin(ReadWrite.READ);
        try {
            Set<Quad> current=record(data,CURRENT,C),source=record(data,REVISIONS,R);
            List<Object> receiptTerms=new ArrayList<>(); receiptTerms.add(termIdentity(ORIGINAL));
            for(String predicate:List.of("operation","admissionId","requestDigest","authorityEpoch","admittedScope","dataEpoch","sequence"))
                receiptTerms.add(termIdentity(one(data,RECEIPTS,ORIGINAL,p(predicate))));
            String key=meaningKey(fixture.value()), sourceDigest=suppliedSourceDigest==null
                ?hash(json(List.of(properties(current),properties(source),receiptTerms,D.getURI(),Q.getURI(),key))):suppliedSourceDigest;
            String uuid=hash(json(List.of(FAMILY,C.getURI(),R.getURI(),sourceDigest))).substring(0,32);
            Node b=uri("https://rezics.com/id/"+uuid.substring(0,8)+"-"+uuid.substring(8,12)+"-"+uuid.substring(12,16)+"-"+uuid.substring(16,20)+"-"+uuid.substring(20));
            Sealed statement=seal(C,STATEMENT_PROFILE,object("revision",b.getURI(),"meaning",meaning(fixture.value()),"meaningKey",key,"speaker",A.getURI(),
                "semanticContextRevision",null,"state","active","evidence",List.of(),"recordedBy",A.getURI(),"retainedSourceRevision",R.getURI(),
                "retainedSourceReceipt",ORIGINAL.getURI(),"recordedAt","2021-02-03T04:05:06.123Z","derivation",DERIVATION.getURI()));
            Set<Quad> next=new LinkedHashSet<>();
            addSet(next,CURRENT,C,RDF.type.asNode(),RDF.Statement.asNode(),RDF.subject.asNode(),S,RDF.predicate.asNode(),uri(P),RDF.object.asNode(),fixture.value(),
                p("relationDefinition"),D,p("interpretationDefinition"),Q,p("qualificationDefinition"),Q,p("interpretationContext"),K,p("valuePrecision"),p("ApproximateValue"),
                p("valueQualifier"),p("DisputedAttribution"),p("valueQualifier"),p("InferredValue"),p("validFrom"),typed("2000-01-01T00:00:00Z",XSD+"dateTime"),
                p("validUntil"),typed("2030-01-01T00:00:00Z",XSD+"dateTime"),p("editionScope"),EDITION,p("speaker"),A,p("meaningKey"),uri(key),
                p("retainedClaimHead"),R,p("statementState"),p("Active"),p("head"),b);
            Set<Quad> bRecord=new LinkedHashSet<>();
            addSet(bRecord,REVISIONS,b,RDF.type.asNode(),p("StatementRevision"),RDF.type.asNode(),p("RevisionAnchor"),p("component"),C,p("statementState"),p("Active"),
                p("recordedBy"),A,p("operation"),O,p("retainedSourceRevision"),R,p("retainedSourceReceipt"),ORIGINAL,p("recordedAt"),typed("2021-02-03T04:05:06.123Z",XSD+"dateTime"),
                p("derivation"),DERIVATION,p("modelRevision"),uri(STATEMENT_PROFILE),p("shapeRevision"),uri(STATEMENT_PROFILE),p("manifest"),uri(statement.iri()),
                p("dataEpoch"),text(SOURCE_EPOCH),p("sequence"),integer(2));
            String metadata="<$RECEIPT> rv:convertedClaim <"+C.getURI()+"> ; rv:sourceClaimRevision <"+R.getURI()+"> ; rv:statementRevision <"+b.getURI()
                +"> ; rv:relationDefinition <"+D.getURI()+"> ; rv:qualificationDefinition <"+Q.getURI()+"> ; rv:sourceDigest "+NodeFmtLib.strNT(text(sourceDigest))+" . ";
            for(var entry:Map.of("RelationManifest",fixture.relation().manifest(),"RelationPayload",fixture.relation().payload(),
                "QualificationManifest",fixture.qualification().manifest(),"QualificationPayload",fixture.qualification().payload(),
                "StatementManifest",statement.manifest(),"StatementPayload",statement.payload()).entrySet())
                metadata+="<$RECEIPT> rv:claimFold"+entry.getKey()+" "+NodeFmtLib.strNT(text(entry.getValue()))+" . ";
            String sourceGuard=graph(CURRENT,triples(current))+graph(REVISIONS,triples(source))+graph(RECEIPTS,"<"+ORIGINAL.getURI()+"> rv:claim <"+C.getURI()
                +"> ; rv:claimRevision <"+R.getURI()+"> ; rv:outcome rv:Succeeded ; rv:operation <"+O.getURI()+"> ; rv:dataEpoch "+NodeFmtLib.strNT(text(SOURCE_EPOCH))+" ; rv:sequence 2 .");
            String defs="";
            for(Node revision:List.of(D,Q)) {
                Node component=revision.equals(D)?DC:QC,kind=revision.equals(D)?p("PropertyDefinition"):p("InterpretationDefinition");
                String manifest=revision.equals(D)?fixture.relation().iri():fixture.qualification().iri();
                defs+=graph(CURRENT,"<"+component.getURI()+"> a rv:SemanticDefinition ; rv:definitionKind <"+kind.getURI()+"> ; rv:definitionHead <"+revision.getURI()+"> .")
                    +graph(REVISIONS,"<"+revision.getURI()+"> a rv:DefinitionRevision ; rv:component <"+component.getURI()+"> ; rv:manifest <"+manifest+"> ; rv:definitionKind <"+kind.getURI()+"> ; rv:lifecycle rv:Active .");
            }
            // Match the owner's activeDirectDefinitionsGuard exactly. A
            // retirement controller need not use the canonical controller IRI.
            defs+=" FILTER NOT EXISTS { VALUES ?usedDefinition { <"+D.getURI()+"> <"+Q.getURI()+"> } "
                +graph(CURRENT,"?definitionControl a rv:DefinitionLifecycle ; rv:definitionRef ?usedDefinition ; rv:definitionState rv:Retired .")+" } ";
            return command("convert",List.of(C.getURI(),R.getURI(),b.getURI(),sourceDigest),triples(current),triples(next),triples(current)+"\n"+triples(bRecord),metadata,
                sourceGuard+defs+" FILTER NOT EXISTS { "+graph(REVISIONS,"<"+b.getURI()+"> ?bp ?bo")+" }",b);
        } finally { data.end(); }
    }
    private static void addSet(Set<Quad> set,Node graph,Node subject,Object... fields) {
        for(int i=0;i<fields.length;i+=2) set.add(new Quad(graph,subject,(Node)fields[i],(Node)fields[i+1]));
    }
    private static CommandPolicy.Plan plan(Command command) {
        var request=UpdateFactory.create(command.update()); var modify=(UpdateModify)request.getOperations().getFirst();
        Set<String> graphs=new HashSet<>(),current=new HashSet<>(),revisions=new HashSet<>();
        for(var quads:List.of(modify.getDeleteQuads(),modify.getInsertQuads())) for(Quad quad:quads) {
            graphs.add(quad.getGraph().getURI());
            if(quad.getGraph().equals(CURRENT)) current.add(quad.getSubject().getURI());
            if(quad.getGraph().equals(REVISIONS)) revisions.add(quad.getSubject().getURI());
        }
        return new CommandPolicy.Plan(request,graphs,current,revisions,Set.of(),false,false,!modify.getDeleteQuads().isEmpty());
    }
    private static String run(DatasetGraph data,Command command) {
        data.begin(ReadWrite.WRITE); boolean committed=false;
        try {
            var plan=plan(command); ClaimStatementFoldPolicy.validateTemplate(plan,command.receipt());
            var existing=data.find(RECEIPTS,uri(command.receipt()),p("requestDigest"),Node.ANY);
            try { if(existing.hasNext()) return existing.next().getObject().equals(text(command.digest()))
                && one(data,RECEIPTS,uri(command.receipt()),ClaimStatementFoldPolicy.templateDigestPredicate()).equals(text(hash(command.update())))?"replayed":"conflict"; }
            finally { Iter.close(existing); }
            var before=CommandInvariant.readControl(data); var snapshot=ClaimStatementFoldPolicy.capture(data,command.receipt(),command.digest(),plan);
            if(snapshot.error()!=null) return "invalid:"+snapshot.error();
            ClaimStatementFoldPolicy.applyExact(data,snapshot,plan);
            String error=ClaimStatementFoldPolicy.check(data,snapshot);
            if(error!=null) return "invalid:"+error;
            var after=CommandInvariant.readControl(data);
            error=ClaimStatementFoldPolicy.checkControl(data,command.receipt(),plan,before,after,before.epoch(),before.sequence());
            if(error!=null) return "invalid:"+error;
            if(command.phase().equals("convert")) {
                var validation=ClaimStatementFoldPolicy.validationView(data,ClaimStatementFoldPolicy.nativePlan(plan,command.receipt()));
                assertNull(CanonicalPolicy.validate(PROFILES,validation,C.getURI(),false));
                assertNull(CanonicalPolicy.validate(PROFILES,validation,command.revision().getURI(),true));
                assertNull(CommandService.validateOne(data,new CommandService.Validation("claim-v1",PROFILES.get("claim-v1"),CLAIM_PROFILE+"/claim-shape",
                    List.of(C.getURI()),List.of(CommandPolicy.REVISIONS),Map.of())));
            }
            data.add(RECEIPTS,uri(command.receipt()),ClaimStatementFoldPolicy.templateDigestPredicate(),text(ClaimStatementFoldPolicy.templateDigest(command.update())));
            data.commit(); committed=true; return "committed";
        } finally { if(!committed) data.abort(); data.end(); }
    }
    private static void acquired(Fixture fixture) { assertEquals("committed",run(fixture.data(),acquire())); }
    @Test public void exactFoldPreservesIdentityLiteralBytesHistoryAndPositionsWithoutAssertingTheBaseTriple() {
        for(Node value:List.of(typed("2020-02-29",XSD+"date"),typed("2020-02-29T12:34:56.123456789+05:30",XSD+"dateTime"))) {
            try(Fixture fixture=fixture(2001,1000,value)) {
                Command convert=conversion(fixture); acquired(fixture); Set<Quad> before=all(fixture.data());
                assertEquals("committed",run(fixture.data(),convert));
                DatasetGraph data=fixture.data(); data.begin(ReadWrite.READ);
                try {
                    assertFalse(data.contains(CURRENT,C,RDF.type.asNode(),p("Claim")));
                    assertTrue(data.contains(REVISIONS,C,RDF.type.asNode(),p("Claim")));
                    assertTrue(data.contains(CURRENT,C,RDF.object.asNode(),value));
                    assertTrue(data.contains(CURRENT,C,p("validFrom"),typed("2000-01-01T00:00:00Z",XSD+"dateTime")));
                    assertTrue(data.contains(CURRENT,C,p("meaningKey"),uri(meaningKey(value))));
                    assertTrue(data.contains(CURRENT,C,p("head"),convert.revision()));
                    assertFalse(data.contains(REVISIONS,convert.revision(),p("predecessor"),Node.ANY));
                    assertFalse(data.contains(REVISIONS,R,RDF.type.asNode(),p("StatementRevision")));
                    assertFalse(data.contains(Node.ANY,S,uri(P),Node.ANY)); assertFalse(data.contains(CURRENT,C,p("principal"),Node.ANY));
                    for(Quad quad:before) if(!quad.getGraph().equals(CURRENT) || !quad.getSubject().equals(C)) assertTrue("retained fact changed: "+quad,data.contains(quad));
                    assertEquals("100",CommandInvariant.readControl(data).sequence().toString());
                    assertEquals(integer(7),one(data,CONTROL,uri(CommandInvariant.MAIN_STREAM_SCOPE),p("streamSequence")));
                } finally { data.end(); }
            }
        }
    }
    @Test public void lostAcknowledgmentsReplayOnlyExactTemplatesWithoutReapplyingTheFold() {
        try(Fixture fixture=fixture(1,0,typed("2020-02-29",XSD+"date"))) {
            Command acquire=acquire(),convert=conversion(fixture);
            assertEquals("committed",run(fixture.data(),acquire)); assertEquals("replayed",run(fixture.data(),acquire));
            assertEquals("committed",run(fixture.data(),convert)); Set<Quad> after=all(fixture.data());
            assertEquals("replayed",run(fixture.data(),convert)); assertEquals(after,all(fixture.data()));
            assertEquals("conflict",run(fixture.data(),convert.changed(convert.update()+"\n"))); assertEquals(after,all(fixture.data()));
        }
    }
    @Test public void sourceAndReceiptCorruptionRefuseAtomicallyInsteadOfReinterpretingTheRetainedRecord() {
        for(String defect:List.of("extra-current","source-type","source-term","source-shape","source-receipt","multiple-receipts","second-root","predecessor",
            "receipt-outcome","receipt-type","receipt-claim","receipt-revision","noncanonical-retirement")) {
            try(Fixture fixture=fixture(1,0,typed("2020-02-29",XSD+"date"))) {
                Command convert=conversion(fixture); acquired(fixture); DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
                try {
                    switch(defect) {
                        case "extra-current" -> data.add(CURRENT,C,p("unreviewed"),text("preserve"));
                        case "source-type" -> data.add(REVISIONS,R,RDF.type.asNode(),p("UnreviewedRevision"));
                        case "source-term" -> { data.deleteAny(REVISIONS,R,p("propositionValue"),Node.ANY); data.add(REVISIONS,R,p("propositionValue"),NodeFactory.createLiteralLang("2020-02-29","en")); }
                        case "source-shape" -> { data.deleteAny(REVISIONS,R,p("shapeRevision"),Node.ANY); data.add(REVISIONS,R,p("shapeRevision"),uri("urn:unreviewed:claim-profile")); }
                        case "source-receipt" -> { data.deleteAny(RECEIPTS,ORIGINAL,p("sequence"),Node.ANY); data.add(RECEIPTS,ORIGINAL,p("sequence"),integer(3)); }
                        case "multiple-receipts" -> { for(Quad quad:record(data,RECEIPTS,ORIGINAL)) data.add(RECEIPTS,uri("urn:other:claim-receipt"),quad.getPredicate(),quad.getObject()); }
                        case "second-root" -> add(data,REVISIONS,id(900),RDF.type.asNode(),p("ClaimRevision"),p("component"),C);
                        case "predecessor" -> data.add(REVISIONS,R,p("predecessor"),id(900));
                        case "receipt-outcome" -> data.add(RECEIPTS,ORIGINAL,p("outcome"),p("Cancelled"));
                        case "receipt-type" -> data.add(RECEIPTS,ORIGINAL,RDF.type.asNode(),p("UnreviewedReceipt"));
                        case "receipt-claim" -> data.add(RECEIPTS,ORIGINAL,p("claim"),id(900));
                        case "receipt-revision" -> data.add(RECEIPTS,ORIGINAL,p("claimRevision"),id(900));
                        case "noncanonical-retirement" -> add(data,CURRENT,id(901),RDF.type.asNode(),p("DefinitionLifecycle"),p("definitionRef"),D,p("definitionState"),p("Retired"));
                        default -> throw new AssertionError(defect);
                    }
                    data.commit();
                } finally { data.end(); }
                Set<Quad> before=all(data); assertTrue(defect,run(data,convert).startsWith("invalid:")); assertEquals(before,all(data));
            }
        }
    }
    @Test public void suppliedObjectKeyQualificationAndSealedBytesCannotOverrideNativeSourceRecomputation() {
        try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
            Command convert=conversion(fixture); acquired(fixture); Set<Quad> before=all(fixture.data());
            // The forged label drives a consistent B identity, sealed payload
            // and phase receipt; only native source recomputation can reject it.
            assertTrue(run(fixture.data(),conversion(fixture,"0".repeat(64))).startsWith("invalid:"));
            assertEquals(before,all(fixture.data()));
            for(String modified:List.of(
                convert.update().replace("<"+meaningKey(fixture.value())+">","<urn:rezics:meaning:"+"0".repeat(64)+">"),
                convert.update().replace("<"+RV+"ApproximateValue>","<"+RV+"ExactValue>"),
                convert.update().replace("rv:claimFoldStatementPayload", "rv:unreviewedStatementPayload"),
                convert.update().replace(fixture.relation().iri(),"urn:rezics:sha256:"+"0".repeat(64)),
                convert.update().replace("2020-02-29", "2020-03-01"))) {
                try { assertTrue(run(fixture.data(),convert.changed(modified)).startsWith("invalid:")); }
                catch(IllegalArgumentException expected) { /* closed template admission rejected before mutation */ }
                assertEquals(before,all(fixture.data()));
            }
        }
    }
    @Test public void hashConsistentSealedDefinitionsStillRequireTheReviewedKindNotationAndEmptyRoles() {
        for(String defect:List.of("notation","roles","kind","qualification")) {
            try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
                boolean qualification=defect.equals("qualification");
                Node component=qualification?QC:DC,revision=qualification?Q:D;
                Map<String,Object> state=object("component","definition","kind",qualification?"interpretation":"property","lifecycle","active",
                    "successor",null,"roles",List.of(),"notation",
                    qualification?"unreviewed-qualification":"statement-first-publication-date-v1");
                if(defect.equals("notation")) state.put("notation","unreviewed-date-meaning");
                if(defect.equals("kind")) state.put("kind","value");
                if(defect.equals("roles")) state.put("roles",List.of(object("key","subject","minParticipants",1,"maxParticipants",1,"ordered",false)));
                Sealed substituted=seal(component,DEFINITION_PROFILE,state);
                DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
                try { data.deleteAny(REVISIONS,revision,p("manifest"),Node.ANY); data.add(REVISIONS,revision,p("manifest"),uri(substituted.iri())); data.commit(); }
                finally { data.end(); }
                Fixture prepared=new Fixture(data,qualification?fixture.relation():substituted,qualification?substituted:fixture.qualification(),fixture.value());
                Command convert=conversion(prepared); acquired(fixture); Set<Quad> before=all(data);
                assertTrue(defect,run(data,convert).startsWith("invalid:")); assertEquals(before,all(data));
            }
        }
    }
    @Test public void arbitraryWhereWorkAndMissingConstantSourceGuardsRefuseBeforeAnyMutation() {
        try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
            Command convert=conversion(fixture); acquired(fixture); Set<Quad> before=all(fixture.data());
            List<String> mutations=new ArrayList<>();
            mutations.add(convert.update().replace(" WHERE { "," WHERE { "+graph(CURRENT,"?unbound <urn:unreviewed:predicate> ?value .")));
            DatasetGraph data=fixture.data(); data.begin(ReadWrite.READ);
            try {
                for(String guard:List.of(graph(CURRENT,triples(record(data,CURRENT,C))),graph(REVISIONS,triples(record(data,REVISIONS,R))))) {
                    int index=convert.update().lastIndexOf(guard); assertTrue("fixture constant guard missing",index>=0);
                    mutations.add(convert.update().substring(0,index)+convert.update().substring(index+guard.length()));
                }
            } finally { data.end(); }
            for(String update:mutations) {
                try { assertTrue(run(data,convert.changed(update)).startsWith("invalid:")); }
                catch(IllegalArgumentException expected) { /* exact template admission refused the query language */ }
                assertEquals(before,all(data));
            }
        }
    }
    @Test public void hashConsistentButNonJsonSealedBytesRejectTrailingDataQuotesAndDuplicateKeys() {
        for(String defect:List.of("trailing-data","single-quotes","duplicate-key")) {
            try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
                String good=fixture.relation().payload();
                String payload=switch(defect) {
                    case "trailing-data" -> good+" {}";
                    case "single-quotes" -> good.replace("\"format\"","'format'");
                    case "duplicate-key" -> good.replace("\"format\":\"rezics-component-v1\"","\"format\":\"rezics-component-v1\",\"format\":\"rezics-component-v1\"");
                    default -> throw new AssertionError(defect);
                };
                Sealed substituted=sealPayload(DC,DEFINITION_PROFILE,payload); DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
                try { data.deleteAny(REVISIONS,D,p("manifest"),Node.ANY); data.add(REVISIONS,D,p("manifest"),uri(substituted.iri())); data.commit(); }
                finally { data.end(); }
                Command convert=conversion(new Fixture(data,substituted,fixture.qualification(),fixture.value())); acquired(fixture); Set<Quad> before=all(data);
                assertTrue(defect,run(data,convert).startsWith("invalid:")); assertEquals(before,all(data));
            }
        }
    }
    @Test public void unrelatedHoldsAndUnqualifiedCompletionOrReleaseNeverCommit() {
        try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
            DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
            try { add(data,CONTROL,PRODUCT,p("restoreHold"),typed("true",XSD+"boolean")); data.add(CONTROL,uri("urn:other:restore"),p("statementUpgradeFence"),typed("true",XSD+"boolean")); data.commit(); }
            finally { data.end(); }
            Set<Quad> before=all(data); assertTrue(run(data,acquire()).startsWith("invalid:")); assertEquals(before,all(data));
        }
        try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
            acquired(fixture); assertEquals("committed",run(fixture.data(),conversion(fixture))); Set<Quad> before=all(fixture.data());
            for(String phase:List.of("complete","release")) {
                Command command=command(phase,List.of(),"","","","","",null);
                try { assertTrue(run(fixture.data(),command).startsWith("invalid:")); }
                catch(IllegalArgumentException expected) { /* no qualified inventory means no admitted terminal phase */ }
                assertEquals(before,all(fixture.data()));
            }
        }
    }
    @Test public void markerFieldsCannotBorrowAProductHoldWithoutTheExactSuccessfulAcquisitionReceipt() {
        for(boolean held:List.of(true,false)) {
            try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
                Command convert=conversion(fixture); DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
                try {
                    data.add(CONTROL,PRODUCT,p("restoreHold"),typed(Boolean.toString(held),XSD+"boolean"));
                    add(data,CONTROL,marker(),p("claimStatementFoldFence"),typed("true",XSD+"boolean"),p("foldMapDigest"),text(mapDigest()));
                    data.commit();
                } finally { data.end(); }
                Set<Quad> before=all(data);
                assertTrue("marker presence is not an acquired job: held="+held,run(data,convert).startsWith("invalid:"));
                assertEquals(before,all(data));
            }
        }
    }
    @Test public void defaultOrMixedGraphFactsCannotEstablishAClaimRootDefinitionOrFreshStatementRevision() {
        for(String defect:List.of("current-head","source-root","relation-definition","qualification-manifest","definition-head","lifecycle","fresh-revision")) {
            try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
                Command convert=conversion(fixture); acquired(fixture); DatasetGraph data=fixture.data();
                data.begin(ReadWrite.WRITE);
                try {
                    if(defect.equals("lifecycle")) {
                        Node lifecycle=uri("urn:rezics:definition-lifecycle:"+hash(Q.getURI()));
                        add(data,Quad.defaultGraphNodeGenerated,lifecycle,RDF.type.asNode(),p("DefinitionLifecycle"),p("definitionRef"),Q,p("definitionState"),p("Active"));
                    } else if(defect.equals("fresh-revision")) data.add(Quad.defaultGraphNodeGenerated,convert.revision(),p("unreviewed"),text("existing default bytes"));
                    else {
                        Node graph=defect.equals("current-head")||defect.equals("definition-head")?CURRENT:REVISIONS;
                        Node subject=defect.equals("current-head")?C:defect.equals("source-root")?R:defect.equals("definition-head")?DC:
                            defect.equals("relation-definition")?D:Q;
                        Node predicate=defect.equals("current-head")?p("claimHead"):defect.equals("definition-head")?p("definitionHead"):
                            defect.equals("qualification-manifest")?p("manifest"):Node.ANY;
                        for(Quad quad:Iter.toList(data.find(graph,subject,predicate,Node.ANY))) {
                            data.delete(quad); data.add(Quad.defaultGraphNodeGenerated,quad.getSubject(),quad.getPredicate(),quad.getObject());
                        }
                    }
                    data.commit();
                } finally { data.end(); }
                Set<Quad> before=all(data);
                // This is the production logical reader which can expose default
                // facts as CURRENT. The policy must inspect physical named facts.
                assertTrue(defect,run(new CommandService.CurrentScope(data),convert).startsWith("invalid:"));
                assertEquals(before,all(data));
            }
        }
    }
    private static long[] countNativeRanges(DatasetGraph data) {
        var table=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getQuadTable().getNodeTupleTable().getTupleTable();
        long[] records={0,0};
        for(String name:List.of("GPOS","GSPO")) {
            var original=table.selectIndex(name); var record=(TupleIndexRecord)original.baseTupleIndex();
            var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),
                new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},(proxy,method,args)->{
                    Object result=method.invoke(record.getRangeIndex(),args);
                    return method.getName().equals("iterator")?Iter.map((Iterator<?>)result,row->{records[name.equals("GPOS")?0:1]++;return row;}):result;
                });
            var counted=new TupleIndexRecord(4,original.getMapping(),name,range.getRecordFactory(),range);
            var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(
                org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},
                (proxy,method,args)->{
                    if(method.getName().equals("baseTupleIndex")) return counted;
                    Object result=method.invoke(original,args);
                    return method.getName().equals("find")&&result instanceof Iterator<?>?Iter.map((Iterator<?>)result,
                        row->{records[name.equals("GPOS")?0:1]++;return row;}):result;
                });
            for(int i=0;i<table.numIndexes();i++) if(table.getIndex(i)==original) table.setTupleIndex(i,observed);
        }
        return records;
    }
    @Test public void oneClaimEligibilityUsesPhysicalTypeComponentIntersectionInsteadOfWalkingAssessmentHistory() {
        List<Long> baseline=null;
        for(int population:List.of(1,4097)) {
            try(Fixture fixture=fixture(population,population,typed("2020-02-29",XSD+"date"))) {
                Command convert=conversion(fixture); acquired(fixture); DatasetGraph data=fixture.data(); long[] records=countNativeRanges(data);
                data.begin(ReadWrite.READ);
                try {
                    var snapshot=ClaimStatementFoldPolicy.capture(data,convert.receipt(),convert.digest(),plan(convert));
                    assertNull(snapshot.error()); assertTrue("native intersection was not physically observed",records[0]>0);
                    assertTrue("native root proof exceeded its tuple bound: "+records[0],records[0]<=128);
                    assertTrue("fixed subject reads were not independently observed",records[1]>0);
                    assertTrue("fixed records exceeded their row bound: "+records[1],records[1]<=512);
                    assertTrue(snapshot.work().seekTuples()<=128); assertTrue(snapshot.work().recordQuads()<=512);
                    List<Long> cost=List.of(records[0],records[1]);
                    if(baseline==null) baseline=cost; else assertEquals("assessment/unrelated typed-ClaimRevision growth increased physical root work",baseline,cost);
                    System.out.println("claim-fold source assessments="+population+" unrelatedTypedClaims="+population+" nativeTuples="+records[0]+" recordRows="+records[1]);
                } finally { data.end(); }
            }
        }
    }
    @Test public void adversarialInterleavingRefusesAtThePhysicalSeekCapWithoutClaimingEligibility() {
        try(Fixture fixture=fixture(0,0,typed("2020-02-29",XSD+"date"))) {
            DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
            try {
                for(int i=0;i<257;i++) {
                    // Alternate physical subject allocation so a leapfrog seek
                    // cannot jump over this entire unrelated type population.
                    add(data,REVISIONS,id(30000+2*i),RDF.type.asNode(),p("ClaimRevision"),p("component"),id(50000+i));
                    add(data,REVISIONS,id(30001+2*i),RDF.type.asNode(),p("ClaimAssessmentRevision"),p("component"),C);
                }
                data.commit();
            } finally { data.end(); }
            Command convert=conversion(fixture); acquired(fixture); Set<Quad> before=all(data); long[] records=countNativeRanges(data);
            data.begin(ReadWrite.READ);
            try {
                var snapshot=ClaimStatementFoldPolicy.capture(data,convert.receipt(),convert.digest(),plan(convert));
                assertNotNull("an incomplete bounded intersection cannot certify the sole root",snapshot.error());
                assertTrue(snapshot.error(),snapshot.error().contains("native eligibility seek work exceeds fixed bound"));
                assertEquals(128,snapshot.work().seekTuples());
                assertTrue("independent physical seek reads exceeded the refusal cap: "+records[0],records[0]>0&&records[0]<=130);
                assertTrue(records[1]<=512);
                System.out.println("claim-fold adversarial assessments=257 typedClaims=257 nativeTuples="+records[0]+" recordRows="+records[1]+" eligibility=refused");
            } finally { data.end(); }
            assertEquals(before,all(data));
        }
    }
}
