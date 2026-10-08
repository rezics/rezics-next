package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.*;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Actual private command dispatch on the manager's isolated native union candidate. */
public class ClaimFoldInventoryCommandTest {
    private static final String RV="https://rezics.com/vocab/", PROFILE="https://rezics.com/definition/statement-v1",
        FAMILY="claim-statement-fold-v1", PREFIX="urn:rezics:name-migration:claim-statement-fold:";
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), REVISIONS=uri(CommandPolicy.REVISIONS),
        RECEIPTS=uri(CommandPolicy.RECEIPTS), CONTROL=uri(CommandPolicy.CONTROL), PRODUCT=uri("urn:rezics:dataset:product");
    private static final ProfileRegistry PROFILES=ProfileRegistry.load(Path.of("profiles"));
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV+value); }
    private static Node id(int value) { return uri("https://rezics.com/id/00000000-0000-4000-8000-%012d".formatted(value)); }
    private static String sha(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch(Exception error) { throw new AssertionError(error); }
    }
    private static Object helper(String method,Class<?>[] parameters,Object... arguments) {
        try { Method target=ClaimStatementFoldTest.class.getDeclaredMethod(method,parameters); target.setAccessible(true); return target.invoke(null,arguments); }
        catch(ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    private static Object field(Object record,String field) {
        try { Method getter=record.getClass().getDeclaredMethod(field); getter.setAccessible(true); return getter.invoke(record); }
        catch(ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    private static Object sourceFixture(int growth) { return helper("fixture",new Class<?>[]{int.class,int.class,Node.class},growth,growth,
        NodeFactory.createLiteralDT("2020-02-29",org.apache.jena.datatypes.xsd.XSDDatatype.XSDdate)); }
    private static Object conversion(Object fixture) { return helper("conversion",new Class<?>[]{fixture.getClass()},fixture); }
    private static String json(Object value) { return (String)helper("json",new Class<?>[]{Object.class},value); }
    private static String receipt(Object command) { return (String)field(command,"receipt"); }
    private static String update(Object command) { return (String)field(command,"update"); }
    private static Set<Quad> all(DatasetGraph data) {
        data.begin(ReadWrite.READ); try { return new HashSet<>(Iter.toList(data.find())); } finally { data.end(); }
    }
    private static long version(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try { return org.apache.jena.tdb2.sys.TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getTxnSystem().getThreadTransaction().getDataVersion(); }
        finally { data.end(); }
    }
    private static Set<Quad> record(DatasetGraph data,Node graph,Node subject) { return new HashSet<>(Iter.toList(data.find(graph,subject,Node.ANY,Node.ANY))); }
    private static Node one(DatasetGraph data,Node graph,Node subject,Node predicate) {
        var values=data.find(graph,subject,predicate,Node.ANY);
        try { assertTrue(values.hasNext()); Node value=values.next().getObject(); assertFalse(values.hasNext()); return value; }
        finally { Iter.close(values); }
    }
    private static JsonObject envelope(Object command) { return envelope(receipt(command),(String)field(command,"digest"),update(command),(Node)field(command,"revision")); }
    private static JsonObject envelope(String receipt,String digest,String update,Node revision) {
        JsonObject result=new JsonObject(); result.put("receipt",receipt); result.put("digest",digest); result.put("update",update); result.put("deadlineMs",30_000);
        JsonArray validations=new JsonArray();
        if(revision!=null) {
            var request=UpdateFactory.create(update); var modify=(UpdateModify)request.getOperations().getFirst();
            Node claim=modify.getInsertQuads().stream().filter(quad->quad.getGraph().equals(CURRENT)&&quad.getPredicate().equals(RDF.type.asNode())&&quad.getObject().equals(RDF.Statement.asNode())).findFirst().orElseThrow().getSubject();
            for(String[] focus:List.of(new String[]{PROFILE+"/statement-shape",claim.getURI()},new String[]{PROFILE+"/revision-shape",revision.getURI()})) {
                JsonObject validation=new JsonObject(); validation.put("profile","statement-v1"); validation.put("sha256",PROFILES.get("statement-v1").sha256()); validation.put("shape",focus[0]);
                JsonArray targets=new JsonArray(); targets.add(new JsonString(focus[1])); validation.put("focus",targets);
                JsonArray graphs=new JsonArray(); graphs.add(new JsonString(CommandPolicy.CURRENT)); graphs.add(new JsonString(CommandPolicy.REVISIONS)); validation.put("graphs",graphs); validations.add(validation);
            }
        }
        result.put("validations",validations); return result;
    }
    private static final class Endpoint implements AutoCloseable {
        final Object fixture; final DatasetGraph raw; final DatasetGraph data;
        final Object acquire=helper("acquire",new Class<?>[]{}), convert;
        final java.util.concurrent.atomic.AtomicBoolean interrupted=new java.util.concurrent.atomic.AtomicBoolean();
        final java.util.concurrent.atomic.AtomicBoolean lateMutation=new java.util.concurrent.atomic.AtomicBoolean();
        final HttpClient client=HttpClient.newHttpClient();
        final FusekiServer server;
        Endpoint() { this(false); }
        Endpoint(boolean cancelCommit) { this(cancelCommit,0); }
        Endpoint(Node cancellationPredicate) { this(true,0,null,cancellationPredicate); }
        Endpoint(java.util.function.Consumer<DatasetGraph> mutation) { this(false,0,null,p("claimFoldRetainedDisposition"),mutation); }
        Endpoint(boolean cancelCommit,int growth) { this(cancelCommit,growth,null); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored) { this(cancelCommit,growth,restored,p("claimFoldDisposition")); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored,Node cancellationPredicate) { this(cancelCommit,growth,restored,cancellationPredicate,null); }
        Endpoint(Path location) { this(false,0,null,p("claimFoldClassification"),null,location); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored,Node cancellationPredicate,java.util.function.Consumer<DatasetGraph> mutation) { this(cancelCommit,growth,restored,cancellationPredicate,mutation,null); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored,Node cancellationPredicate,java.util.function.Consumer<DatasetGraph> mutation,Path location) {
            fixture=sourceFixture(growth); DatasetGraph memory=(DatasetGraph)field(fixture,"data"); convert=conversion(fixture);
            if(location!=null) {
                // A persistent TDB2 store is required so a later JVM can reopen exactly what this one wrote.
                DatasetGraph disk=org.apache.jena.tdb2.TDB2Factory.connectDataset(location.toString()).asDatasetGraph(); memory.begin(ReadWrite.READ); disk.begin(ReadWrite.WRITE);
                try { Iter.toList(memory.find()).forEach(disk::add); disk.commit(); } finally { disk.end(); memory.end(); }
                memory=disk;
            }
            persistent=location!=null; raw=memory;
            if(restored!=null) {
                raw.begin(ReadWrite.WRITE);
                try { raw.deleteAny(Node.ANY,Node.ANY,Node.ANY,Node.ANY); restored.forEach(raw::add); raw.commit(); }
                finally { raw.end(); }
            }
            data=cancelCommit||mutation!=null?new DatasetGraphWrapper(raw) {
                private void observe(Node graph,Node subject,Node predicate) {
                    boolean target=predicate.equals(cancellationPredicate)&&(Set.of(p("claimFoldDisposition"),p("claimFoldRetainedDisposition"),p("claimFoldClassification")).contains(cancellationPredicate)?graph.equals(uri(TemplateIndexService.STATE)):
                        graph.equals(RECEIPTS)&&subject.isURI()&&subject.getURI().startsWith(PREFIX+"convert:"));
                    if(target&&mutation!=null&&lateMutation.compareAndSet(false,true)) mutation.accept(raw);
                    if(target&&cancelCommit
                        &&interrupted.compareAndSet(false,true)) Thread.currentThread().interrupt();
                }
                @Override public void add(Quad quad) { super.add(quad); observe(quad.getGraph(),quad.getSubject(),quad.getPredicate()); }
                @Override public void add(Node graph,Node subject,Node predicate,Node object) { super.add(graph,subject,predicate,object); observe(graph,subject,predicate); }
                @Override public void end() { try { super.end(); } finally { if(interrupted.get()) Thread.interrupted(); } }
            }:raw;
            Operation operation=Operation.alloc("https://rezics.com/fuseki/command","command","REZICS transactional command");
            CommandService service=new CommandService(PROFILES,"1".repeat(64).getBytes(StandardCharsets.US_ASCII),"2".repeat(64).getBytes(StandardCharsets.US_ASCII),"3".repeat(64).getBytes(StandardCharsets.US_ASCII));
            server=FusekiServer.create().port(0).add("/data",data,false).registerOperation(operation,service).addEndpoint("/data","command",operation).build().start();
        }
        HttpResponse<String> post(JsonObject envelope,String token) throws Exception {
            return postRaw(JSON.toStringFlat(envelope),token);
        }
        HttpResponse<String> postRaw(String body,String token) throws Exception {
            var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+server.getPort()+"/data/command"))
                .header("Content-Type","application/json").timeout(java.time.Duration.ofSeconds(30));
            if(token!=null) request.header("Authorization","Bearer "+token);
            return client.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
        }
        JsonObject execute(JsonObject envelope) throws Exception { var response=post(envelope,"1".repeat(64)); assertEquals(response.body(),200,response.statusCode()); return JSON.parse(response.body()); }
        final boolean persistent;
        @Override public void close() {
            server.stop(); client.close();
            // release the on-disk lock so another JVM can reopen the exact files
            if(persistent) org.apache.jena.tdb2.sys.TDBInternal.expel(raw); else data.close();
        }
    }
    @SuppressWarnings("unchecked")
    private static JsonObject inventory(Endpoint endpoint,String attempt,int page,String previous) {
        Map<String,Object> fence=(Map<String,Object>)helper("fence",new Class<?>[]{});
        JsonObject job=new JsonObject(); job.put("dataEpoch","current-epoch"); job.put("routingEpoch","9");
        for(String key:List.of("marker","mapDigest","job")) job.put(key,(String)fence.get(key)); job.put("acquireReceipt",receipt(endpoint.acquire));
        JsonObject input=new JsonObject(); input.put("job",job); input.put("attempt",attempt); input.put("page",page); input.put("previous",previous);
        input.put("requestId",UUID.randomUUID().toString()); input.put("deadline",System.currentTimeMillis()+30_000);
        JsonObject envelope=new JsonObject(); envelope.put("claimFoldInventory",input); return envelope;
    }
    private static String status(JsonObject value) { return value.get("status").getAsString().value(); }
    private static JsonObject disposition(Endpoint endpoint,JsonObject source,JsonObject row) {
        JsonObject input=new JsonObject(); input.put("job",inventory(endpoint,UUID.randomUUID().toString(),0,"").get("claimFoldInventory").getAsObject().get("job"));
        input.put("sourceCut",source.get("sourceCut")); input.put("seal",source.get("hash"));
        for(String key:List.of("claim","head","witness")) input.put(key,row.get(key));
        input.put("deadline",System.currentTimeMillis()+30_000);
        JsonObject request=new JsonObject(); request.put("claimFoldDisposition",input); return request;
    }
    private static JsonObject members(Endpoint endpoint,JsonObject source,String progress) {
        JsonObject input=new JsonObject(); input.put("job",inventory(endpoint,UUID.randomUUID().toString(),0,"").get("claimFoldInventory").getAsObject().get("job"));
        input.put("sourceCut",source.get("sourceCut")); input.put("seal",source.get("hash")); input.put("progress",progress); input.put("deadline",System.currentTimeMillis()+30_000);
        JsonObject request=new JsonObject(); request.put("claimFoldMembers",input); return request;
    }
    private static JsonObject classify(Endpoint endpoint,JsonObject source,String progress) {
        JsonObject request=new JsonObject(); request.put("claimFoldClassify",members(endpoint,source,progress).get("claimFoldMembers")); return request;
    }
    private static Map<String,JsonObject> sourceRows(Endpoint endpoint,JsonObject source) throws Exception {
        Map<String,JsonObject> rows=new HashMap<>(); String progress="";
        do {
            JsonObject last=endpoint.execute(members(endpoint,source,progress)); assertEquals(last.toString(),"read",status(last));
            for(JsonValue row:last.get("rows").getAsArray()) rows.put(row.getAsObject().get("claim").getAsString().value(),row.getAsObject());
            progress=last.get("progress").getAsString().value();
        } while(!progress.isEmpty());
        return rows;
    }
    private record RetainedSource(JsonObject source,JsonObject row) {}
    private static RetainedSource captureRetainedSource(Endpoint endpoint) throws Exception {
        assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
        String attempt=UUID.randomUUID().toString(),previous=""; JsonObject source,row=null; int ordinal=0;
        do {
            source=endpoint.execute(inventory(endpoint,attempt,ordinal++,previous)); assertEquals(source.toString(),"committed",status(source));
            for(JsonValue item:source.get("rows").getAsArray()) if(item.getAsObject().get("claim").getAsString().value().equals(id(1).getURI())) row=item.getAsObject();
            previous=source.get("hash").getAsString().value(); assertTrue(ordinal<=30);
        } while(!source.get("sourceComplete").getAsBoolean().value());
        return new RetainedSource(source,Objects.requireNonNull(row));
    }
    private static void outsidePredicate(Endpoint endpoint,String defect) {
        endpoint.data.begin(ReadWrite.WRITE);
        try {
            for(Node graph:List.of(CURRENT,REVISIONS)) {
                Node subject=graph.equals(CURRENT)?id(1):id(2); endpoint.data.deleteAny(graph,subject,p("propositionPredicate"),Node.ANY);
                endpoint.data.add(graph,subject,p("propositionPredicate"),uri(defect.equals("inside-predicate")?"https://schema.org/datePublished":graph.equals(REVISIONS)&&defect.equals("predicate-mismatch")?"https://schema.org/dateModified":"https://schema.org/dateCreated"));
            }
            if(defect.equals("unknown-value")) { endpoint.data.deleteAny(REVISIONS,id(2),p("propositionValue"),Node.ANY); endpoint.data.add(REVISIONS,id(2),p("propositionValue"),NodeFactory.createLiteralString("not a reviewed date")); }
            if(defect.equals("missing-value")) endpoint.data.deleteAny(REVISIONS,id(2),p("propositionValue"),Node.ANY);
            if(defect.equals("uncertain-precision")) { endpoint.data.deleteAny(REVISIONS,id(2),p("valuePrecision"),Node.ANY); endpoint.data.add(REVISIONS,id(2),p("valuePrecision"),p("UncertainValue")); }
            if(defect.equals("ambiguous-history")) { endpoint.data.add(REVISIONS,id(900),RDF.type.asNode(),p("ClaimRevision")); endpoint.data.add(REVISIONS,id(900),p("component"),id(1)); }
            if(defect.equals("missing-speaker")) endpoint.data.deleteAny(REVISIONS,id(2),p("statedBy"),Node.ANY);
            if(defect.equals("invalid-recordedAt")) { endpoint.data.deleteAny(REVISIONS,id(2),p("recordedAt"),Node.ANY); endpoint.data.add(REVISIONS,id(2),p("recordedAt"),NodeFactory.createLiteralString("not a native recorded instant")); }
            if(defect.equals("oversized-definition")) { endpoint.data.deleteAny(REVISIONS,id(10),p("sequence"),Node.ANY); endpoint.data.add(REVISIONS,id(10),p("sequence"),NodeFactory.createLiteralDT("1".repeat(40960),org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)); }
            if(defect.equals("default-definition")) endpoint.data.add(Quad.defaultGraphNodeGenerated,id(10),p("operation"),uri("urn:unreviewed:default-definition"));
            if(defect.equals("missing-receipt")) endpoint.data.deleteAny(RECEIPTS,uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create")),p("outcome"),Node.ANY);
            endpoint.data.commit();
        } finally { endpoint.data.end(); }
    }
    private static JsonObject retain(Endpoint endpoint,RetainedSource source) {
        JsonObject input=JSON.parse(disposition(endpoint,source.source(),source.row()).get("claimFoldDisposition").toString());
        input.put("relationDefinition",id(10).getURI()); input.put("qualificationDefinition",id(11).getURI());
        for(String pair:List.of("relation","qualification")) {
            Object sealed=field(endpoint.fixture,pair); input.put(pair+"Manifest",(String)field(sealed,"manifest")); input.put(pair+"Payload",(String)field(sealed,"payload"));
        }
        JsonObject request=new JsonObject(); request.put("claimFoldRetain",input); return request;
    }
    @Test public void existingPrivateEndpointAuthenticatesInventoryBeforeClosedSchemaAndBoundsItsEnvelope() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            JsonObject valid=inventory(endpoint,UUID.randomUUID().toString(),0,""); Set<Quad> before=all(endpoint.data);
            for(String token:Arrays.asList(null,"2".repeat(64))) {
                JsonObject malformed=new JsonObject(); malformed.put("claimFoldInventory",false);
                var response=endpoint.post(malformed,token); assertEquals(response.body(),403,response.statusCode()); assertEquals(before,all(endpoint.data));
            }
            List<JsonObject> rejected=new ArrayList<>();
            JsonObject malformed=new JsonObject(); malformed.put("claimFoldInventory",false); rejected.add(malformed);
            JsonObject mixed=JSON.parse(valid.toString()); mixed.put("templateIndex",new JsonObject()); rejected.add(mixed);
            JsonObject unknown=JSON.parse(valid.toString()); unknown.get("claimFoldInventory").getAsObject().put("trusted",true); rejected.add(unknown);
            JsonObject jobUnknown=JSON.parse(valid.toString()); jobUnknown.get("claimFoldInventory").getAsObject().get("job").getAsObject().put("producersClosed",true); rejected.add(jobUnknown);
            JsonObject oversized=JSON.parse(valid.toString()); oversized.get("claimFoldInventory").getAsObject().get("job").getAsObject().put("job","x".repeat(16*1024)); rejected.add(oversized);
            JsonObject callerProof=JSON.parse(valid.toString()); callerProof.put("claimFoldInventoryProof",new JsonObject()); rejected.add(callerProof);
            for(JsonObject bad:rejected) { var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); assertEquals(before,all(endpoint.data)); }
            String raw=JSON.toStringFlat(valid);
            for(String malformedRaw:List.of(raw+" {}",raw.replaceFirst("\"page\"\\s*:\\s*0","\"page\":0,\"page\":0"))) {
                assertNotEquals("duplicate-key fixture must differ from valid JSON",raw,malformedRaw);
                var response=endpoint.postRaw(malformedRaw,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); assertEquals(before,all(endpoint.data));
            }
        }
    }
    @Test public void dispositionReadRequiresMaintenanceAuthAndAClosedBoundedEnvelope() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            JsonObject source=new JsonObject(); source.put("sourceCut","a".repeat(64)); source.put("hash","b".repeat(64));
            JsonObject row=new JsonObject(); row.put("claim",id(1).getURI()); row.put("head",id(2).getURI()); row.put("witness","c".repeat(64));
            JsonObject valid=disposition(endpoint,source,row); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject malformed=new JsonObject(); malformed.put("claimFoldDisposition",false);
            for(String token:Arrays.asList(null,"2".repeat(64))) {
                var response=endpoint.post(malformed,token); assertEquals(response.body(),403,response.statusCode());
            }
            List<JsonObject> rejected=new ArrayList<>(); rejected.add(malformed);
            JsonObject mixed=JSON.parse(valid.toString()); mixed.put("claimFoldInventory",new JsonObject()); rejected.add(mixed);
            JsonObject unknown=JSON.parse(valid.toString()); unknown.get("claimFoldDisposition").getAsObject().put("converted",true); rejected.add(unknown);
            JsonObject jobUnknown=JSON.parse(valid.toString()); jobUnknown.get("claimFoldDisposition").getAsObject().get("job").getAsObject().put("trusted",true); rejected.add(jobUnknown);
            JsonObject oversized=JSON.parse(valid.toString()); oversized.get("claimFoldDisposition").getAsObject().get("job").getAsObject().put("job","x".repeat(16*1024)); rejected.add(oversized);
            JsonObject malformedIdentity=JSON.parse(valid.toString()); malformedIdentity.get("claimFoldDisposition").getAsObject().put("witness","not-a-hash"); rejected.add(malformedIdentity);
            for(JsonObject bad:rejected) {
                var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode());
                assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            }
            String raw=JSON.toStringFlat(valid);
            for(String bad:List.of(raw+" {}",raw.replaceFirst("\"witness\"\\s*:\\s*\"c{64}\"","\"witness\":\""+"c".repeat(64)+"\",\"witness\":\""+"c".repeat(64)+"\""))) {
                assertNotEquals(raw,bad); var response=endpoint.postRaw(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode());
            }
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            JsonObject directory=members(endpoint,source,""); JsonObject malformedDirectory=new JsonObject(); malformedDirectory.put("claimFoldMembers",false);
            for(String token:Arrays.asList(null,"2".repeat(64))) assertEquals(403,endpoint.post(malformedDirectory,token).statusCode());
            List<JsonObject> directoryRejected=new ArrayList<>(); directoryRejected.add(malformedDirectory);
            for(String field:List.of("after","count","directoryEOF","trusted")) {
                JsonObject bad=JSON.parse(directory.toString()); bad.get("claimFoldMembers").getAsObject().put(field,"caller supplied"); directoryRejected.add(bad);
            }
            JsonObject directoryMixed=JSON.parse(directory.toString()); directoryMixed.put("claimFoldDisposition",new JsonObject()); directoryRejected.add(directoryMixed);
            JsonObject directoryOversized=JSON.parse(directory.toString()); directoryOversized.get("claimFoldMembers").getAsObject().put("progress","x".repeat(16*1024)); directoryRejected.add(directoryOversized);
            for(JsonObject bad:directoryRejected) {
                var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            }
            JsonObject retained=retain(endpoint,new RetainedSource(source,row)),malformedRetained=new JsonObject(); malformedRetained.put("claimFoldRetain",false);
            for(String token:Arrays.asList(null,"2".repeat(64))) assertEquals(403,endpoint.post(malformedRetained,token).statusCode());
            List<JsonObject> retainRejected=new ArrayList<>(); retainRejected.add(malformedRetained);
            for(String field:List.of("reason","verdict","eligible")) { JsonObject bad=JSON.parse(retained.toString()); bad.get("claimFoldRetain").getAsObject().put(field,"caller supplied"); retainRejected.add(bad); }
            JsonObject retainedMixed=JSON.parse(retained.toString()); retainedMixed.put("claimFoldDisposition",new JsonObject()); retainRejected.add(retainedMixed);
            JsonObject retainedOversized=JSON.parse(retained.toString()); retainedOversized.get("claimFoldRetain").getAsObject().put("relationPayload","x".repeat(16*1024)); retainRejected.add(retainedOversized);
            for(JsonObject bad:retainRejected) {
                var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            }
            JsonObject classifier=classify(endpoint,source,""); JsonObject malformedClassifier=new JsonObject(); malformedClassifier.put("claimFoldClassify",false);
            for(String token:Arrays.asList(null,"2".repeat(64))) assertEquals(403,endpoint.post(malformedClassifier,token).statusCode());
            for(String field:List.of("after","count","classificationEOF","converted","retained","verdict")) {
                JsonObject bad=JSON.parse(classifier.toString()); bad.get("claimFoldClassify").getAsObject().put(field,"caller supplied");
                var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode());
            }
            JsonObject mixedClassifier=JSON.parse(classifier.toString()); mixedClassifier.put("claimFoldMembers",new JsonObject()); assertEquals(400,endpoint.post(mixedClassifier,"1".repeat(64)).statusCode());
            JsonObject oversizedClassifier=JSON.parse(classifier.toString()); oversizedClassifier.get("claimFoldClassify").getAsObject().put("progress","x".repeat(16*1024)); assertEquals(400,endpoint.post(oversizedClassifier,"1".repeat(64)).statusCode());
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    private static Node remap(Node node,Map<Node,Node> mapping) { return mapping.getOrDefault(node,node); }
    private static void addSecondSourceAndFillers(Endpoint endpoint) { addSecondSourceAndFillers(endpoint,127); }
    private static void addSecondSourceAndFillers(Endpoint endpoint,int population) {
        Node c=id(500),r=id(501),original=uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000550"+'\0'+"claim-create"));
        Node firstOriginal=uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create"));
        Map<Node,Node> mapping=Map.of(id(1),c,id(2),r,firstOriginal,original,NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000050"),NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000550"));
        endpoint.data.begin(ReadWrite.WRITE);
        try {
            for(Node[] source:List.of(new Node[]{CURRENT,id(1)},new Node[]{REVISIONS,id(2)},new Node[]{RECEIPTS,firstOriginal}))
                for(Quad quad:record(endpoint.data,source[0],source[1])) endpoint.data.add(quad.getGraph(),remap(quad.getSubject(),mapping),quad.getPredicate(),remap(quad.getObject(),mapping));
            for(int i=0;i<population;i++) {
                Node filler=id(20000+i),head=id(40000+i);
                endpoint.data.add(CURRENT,filler,RDF.type.asNode(),p("Claim"));
                endpoint.data.add(CURRENT,filler,p("referent"),uri("urn:inventory:other-subject")); endpoint.data.add(CURRENT,filler,p("interpretationContext"),uri("urn:inventory:context"));
                endpoint.data.add(CURRENT,filler,p("propositionPredicate"),uri("https://schema.org/datePublished")); endpoint.data.add(CURRENT,filler,p("claimHead"),head); endpoint.data.add(CURRENT,filler,p("claimState"),p("Active"));
                endpoint.data.add(REVISIONS,head,RDF.type.asNode(),p("ClaimRevision")); endpoint.data.add(REVISIONS,head,RDF.type.asNode(),p("RevisionAnchor")); endpoint.data.add(REVISIONS,head,p("component"),filler);
                endpoint.data.add(REVISIONS,head,p("modelRevision"),uri("https://rezics.com/definition/claim-v1")); endpoint.data.add(REVISIONS,head,p("shapeRevision"),uri("https://rezics.com/definition/claim-v1"));
                endpoint.data.add(REVISIONS,head,p("dataEpoch"),NodeFactory.createLiteralString("source-epoch")); endpoint.data.add(REVISIONS,head,p("sequence"),NodeFactory.createLiteralDT("2",org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            }
            endpoint.data.commit();
        } finally { endpoint.data.end(); }
    }
    /** Complete native-eligible sources, not asserted final dispositions. Every clone is retained through the real endpoint. */
    private static void addClassificationSources(Endpoint endpoint,int retained) {
        Node original=uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create"));
        endpoint.data.begin(ReadWrite.WRITE);
        try {
            List<Quad> current=Iter.toList(endpoint.data.find(CURRENT,id(1),Node.ANY,Node.ANY)),revision=Iter.toList(endpoint.data.find(REVISIONS,id(2),Node.ANY,Node.ANY)),receipt=Iter.toList(endpoint.data.find(RECEIPTS,original,Node.ANY,Node.ANY));
            for(int i=0;i<retained;i++) {
                String admission="00000000-0000-4000-8000-%012d".formatted(15000+i); Node claim=id(500+i*2),head=id(501+i*2),created=uri("urn:rezics:receipt:"+sha(admission+'\0'+"claim-create"));
                Map<Node,Node> mapping=Map.of(id(1),claim,id(2),head,original,created,NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000050"),NodeFactory.createLiteralString(admission));
                for(List<Quad> record:List.of(current,revision,receipt)) for(Quad quad:record) endpoint.data.add(quad.getGraph(),remap(quad.getSubject(),mapping),quad.getPredicate(),quad.getPredicate().equals(p("propositionPredicate"))?uri("https://schema.org/dateCreated"):remap(quad.getObject(),mapping));
            }
            endpoint.data.commit();
        } finally { endpoint.data.end(); }
    }
    private static void classificationNoise(Endpoint endpoint,int population) {
        endpoint.data.begin(ReadWrite.WRITE);
        try {
            @SuppressWarnings("unchecked") Map<String,Object> fence=(Map<String,Object>)helper("fence",new Class<?>[]{}); Node header=uri((String)fence.get("marker")+":inventory");
            for(int i=0;i<population;i++) {
                Node ack=uri("urn:rezics:claim-inventory-turn:"+UUID.nameUUIDFromBytes(("classification-noise-"+i).getBytes(StandardCharsets.UTF_8)));
                endpoint.data.add(uri(TemplateIndexService.STATE),ack,p("inventoryJob"),header); endpoint.data.add(uri(TemplateIndexService.STATE),ack,p("requestDigest"),NodeFactory.createLiteralString(sha("noise-"+i)));
                var result=new ClaimFoldInventory.Result("committed",false,UUID.nameUUIDFromBytes(("prior-classification-attempt-"+i).getBytes(StandardCharsets.UTF_8)).toString(),0,"",sha("prior-page-"+i),0,List.of(),sha("prior-cut-"+i),null);
                endpoint.data.add(uri(TemplateIndexService.STATE),ack,p("inventoryResult"),NodeFactory.createLiteralString(JSON.toStringFlat(ClaimFoldInventory.json(result))));
                endpoint.data.add(Quad.defaultGraphNodeGenerated,uri("urn:classification:unrelated-default:"+i),RDF.type.asNode(),p("UnrelatedResource"));
                endpoint.data.add(Quad.defaultGraphNodeGenerated,uri("urn:classification:unrelated-default:"+i),p("description"),NodeFactory.createLiteralString("unrelated default "+i));
            }
            // Even the empty baseline has this preparation transaction, so physical versions have equal digit widths.
            endpoint.data.commit();
        } finally { endpoint.data.end(); }
    }
    /** Observe all named/default native indexes; tuple and probe totals are independent of the helper work result. */
    private static final class CountedNativeIterator implements Iterator<Object>,org.apache.jena.atlas.lib.Closeable {
        final Iterator<?> source; final java.util.function.Consumer<Object> consumed; Object buffered; boolean ready;
        CountedNativeIterator(Iterator<?> source,java.util.function.Consumer<Object> consumed) { this.source=source; this.consumed=consumed; }
        @Override public boolean hasNext() { if(ready) return true; if(!source.hasNext()) return false; buffered=source.next(); consumed.accept(buffered); ready=true; return true; }
        @Override public Object next() { if(!hasNext()) throw new NoSuchElementException(); ready=false; return buffered; }
        @Override public void close() { Iter.close(source); }
    }
    private static long[] classifierPhysical(DatasetGraph data,Runnable consumed) {
        var storage=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)); long[] reads={0,0,0};
        for(var nodeTable:List.of(storage.getQuadTable().getNodeTupleTable(),storage.getTripleTable().getNodeTupleTable())) {
            var nodes=nodeTable.getNodeTable(); var table=nodeTable.getTupleTable();
            for(int index=0;index<table.numIndexes();index++) {
                var original=table.getIndex(index); var base=(org.apache.jena.tdb2.store.tupletable.TupleIndexRecord)original.baseTupleIndex(); int width=original.getTupleLength();
                java.util.function.Consumer<Object> count=row->{
                    reads[0]++; consumed.run();
                    if(row instanceof org.apache.jena.atlas.lib.tuple.Tuple<?> tuple) for(int field=0;field<tuple.len();field++) reads[2]+=NodeFmtLib.strNT(nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(field))).getBytes(StandardCharsets.UTF_8).length;
                    else if(row instanceof org.apache.jena.dboe.base.record.Record record) for(int offset=0;offset<record.getKey().length;offset+=8) reads[2]+=NodeFmtLib.strNT(nodes.getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(record.getKey(),offset))).getBytes(StandardCharsets.UTF_8).length;
                };
                var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},(proxy,method,args)->{
                    Object result=method.invoke(base.getRangeIndex(),args);
                    if(!method.getName().equals("iterator")) return result; reads[1]++;
                    return new CountedNativeIterator((Iterator<?>)result,count);
                });
                var counted=new org.apache.jena.tdb2.store.tupletable.TupleIndexRecord(width,original.getMapping(),original.getName(),range.getRecordFactory(),range);
                var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},(proxy,method,args)->{
                    if(method.getName().equals("baseTupleIndex")) return counted;
                    Object result=method.invoke(original,args);
                    if(!method.getName().equals("find")||!(result instanceof Iterator<?>)) return result; reads[1]++;
                    return new CountedNativeIterator((Iterator<?>)result,count);
                });
                table.setTupleIndex(index,observed);
            }
        }
        return reads;
    }
    private static Node supplied(UpdateModify modify,Node graph,Node subject,Node predicate) {
        return modify.getInsertQuads().stream().filter(quad->quad.getGraph().equals(graph)&&quad.getSubject().equals(subject)&&quad.getPredicate().equals(predicate)).findFirst().orElseThrow().getObject();
    }
    @SuppressWarnings("unchecked")
    private static Object javaValue(JsonValue value) {
        if(value.isNull()) return null; if(value.isString()) return value.getAsString().value(); if(value.isBoolean()) return value.getAsBoolean().value();
        if(value.isArray()) { List<Object> result=new ArrayList<>(); for(JsonValue entry:value.getAsArray()) result.add(javaValue(entry)); return result; }
        if(value.isObject()) { Map<String,Object> result=new LinkedHashMap<>(); for(String key:value.getAsObject().keys()) result.put(key,javaValue(value.getAsObject().get(key))); return result; }
        return value.getAsNumber().value();
    }
    /** Translate only test C/R identities, rebuilding every derived hash and sealed B artifact. */
    @SuppressWarnings("unchecked")
    private static JsonObject secondConversion(Endpoint endpoint) {
        Node c=id(500),r=id(501),original=uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000550"+'\0'+"claim-create"));
        String key=(String)helper("meaningKey",new Class<?>[]{Node.class},field(endpoint.fixture,"value"));
        endpoint.data.begin(ReadWrite.READ); String sourceDigest;
        try {
            List<Object> terms=new ArrayList<>(); terms.add(helper("termIdentity",new Class<?>[]{Node.class},original));
            for(String predicate:List.of("operation","admissionId","requestDigest","authorityEpoch","admittedScope","dataEpoch","sequence")) terms.add(helper("termIdentity",new Class<?>[]{Node.class},one(endpoint.data,RECEIPTS,original,p(predicate))));
            sourceDigest=sha(json(List.of(helper("properties",new Class<?>[]{Set.class},record(endpoint.data,CURRENT,c)),helper("properties",new Class<?>[]{Set.class},record(endpoint.data,REVISIONS,r)),terms,id(10).getURI(),id(11).getURI(),key)));
        } finally { endpoint.data.end(); }
        String raw=sha(json(List.of(FAMILY,c.getURI(),r.getURI(),sourceDigest))).substring(0,32);
        Node b=uri("https://rezics.com/id/"+raw.substring(0,8)+"-"+raw.substring(8,12)+"-"+raw.substring(12,16)+"-"+raw.substring(16,20)+"-"+raw.substring(20));
        var modify=(UpdateModify)UpdateFactory.create(update(endpoint.convert)).getOperations().getFirst(); Node own=uri(receipt(endpoint.convert)),oldB=(Node)field(endpoint.convert,"revision");
        JsonObject payload=JSON.parse(supplied(modify,RECEIPTS,own,p("claimFoldStatementPayload")).getLiteralLexicalForm());
        Map<String,Object> state=(Map<String,Object>)javaValue(payload.get("state")); state.put("revision",b.getURI()); state.put("retainedSourceRevision",r.getURI()); state.put("retainedSourceReceipt",original.getURI());
        Object seal=helper("seal",new Class<?>[]{Node.class,String.class,Map.class},c,PROFILE,state);
        Map<String,Object> fence=(Map<String,Object>)helper("fence",new Class<?>[]{});
        String digest=sha(json(List.of(FAMILY,"convert","current-epoch","9",fence,c.getURI(),r.getURI(),b.getURI(),sourceDigest))),receipt=PREFIX+"convert:"+digest;
        String translated=update(endpoint.convert)
            .replace(NodeFmtLib.strNT(supplied(modify,RECEIPTS,own,p("claimFoldStatementManifest"))),NodeFmtLib.strNT(NodeFactory.createLiteralString((String)field(seal,"manifest"))))
            .replace(NodeFmtLib.strNT(supplied(modify,RECEIPTS,own,p("claimFoldStatementPayload"))),NodeFmtLib.strNT(NodeFactory.createLiteralString((String)field(seal,"payload"))))
            .replace(supplied(modify,REVISIONS,oldB,p("manifest")).getURI(),(String)field(seal,"iri"))
            .replace(id(1).getURI(),c.getURI()).replace(id(2).getURI(),r.getURI()).replace(oldB.getURI(),b.getURI())
            .replace("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create"),original.getURI())
            .replace(supplied(modify,RECEIPTS,own,p("sourceDigest")).getLiteralLexicalForm(),sourceDigest)
            .replace(receipt(endpoint.convert),receipt).replace((String)field(endpoint.convert,"digest"),digest);
        return envelope(receipt,digest,translated,b);
    }
    @Test public void nativeRegistrationBlocksPartialEntryAndAnUnrelatedCommitPreventsFurtherConversions() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            addSecondSourceAndFillers(endpoint); JsonObject second=secondConversion(endpoint);
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            String attempt=UUID.randomUUID().toString(); JsonObject firstRequest=inventory(endpoint,attempt,0,"");
            JsonObject page=endpoint.execute(firstRequest); assertEquals("committed",status(page)); assertFalse(page.get("sourceComplete").getAsBoolean().value());
            Set<Quad> preSeal=all(endpoint.data);
            assertEquals(page.toString(),endpoint.execute(firstRequest).toString()); assertEquals(preSeal,all(endpoint.data));
            JsonObject denied=endpoint.execute(envelope(endpoint.convert)); assertEquals(denied.toString(),"invalid",status(denied)); assertEquals(preSeal,all(endpoint.data));
            JsonObject lastRequest=inventory(endpoint,attempt,1,page.get("hash").getAsString().value());
            JsonObject last=endpoint.execute(lastRequest);
            assertEquals(last.toString(),"committed",status(last)); assertTrue(last.get("sourceComplete").getAsBoolean().value()); assertEquals(129,last.get("total").getAsNumber().value().longValue());
            Set<Quad> beforeFold=all(endpoint.data);
            assertEquals(last.toString(),endpoint.execute(lastRequest).toString()); assertEquals(beforeFold,all(endpoint.data));
            JsonObject converted=endpoint.execute(envelope(endpoint.convert)); assertEquals(converted.toString(),"committed",status(converted));
            endpoint.data.begin(ReadWrite.READ);
            try {
                assertTrue(endpoint.data.contains(CURRENT,id(1),RDF.type.asNode(),RDF.Statement.asNode())); assertTrue(endpoint.data.contains(REVISIONS,id(1),RDF.type.asNode(),p("Claim")));
                assertFalse(endpoint.data.contains(REVISIONS,(Node)field(endpoint.convert,"revision"),p("predecessor"),Node.ANY));
                for(Quad quad:beforeFold) if(!quad.getGraph().equals(CURRENT)||!quad.getSubject().equals(id(1))) assertTrue("original source/custody changed: "+quad,endpoint.data.contains(quad));
                assertEquals("100",CommandInvariant.readControl(endpoint.data).sequence().toString());
            } finally { endpoint.data.end(); }
            Set<Quad> afterFold=all(endpoint.data); JsonObject replay=endpoint.execute(envelope(endpoint.convert)); assertEquals("committed",status(replay)); assertEquals(afterFold,all(endpoint.data));
            endpoint.data.begin(ReadWrite.WRITE);
            try { endpoint.data.add(CONTROL,uri("urn:unrelated:maintenance"),p("heartbeat"),NodeFactory.createLiteralString("physical cut changed")); endpoint.data.commit(); }
            finally { endpoint.data.end(); }
            Set<Quad> afterUnrelated=all(endpoint.data);
            JsonObject secondDenied=endpoint.execute(second); assertEquals(secondDenied.toString(),"invalid",status(secondDenied)); assertEquals(afterUnrelated,all(endpoint.data));
            assertTrue("refusal must come from the native exhaustive-job gate",secondDenied.toString().toLowerCase(Locale.ROOT).contains("inventory"));
        }
    }
    @Test public void unregisteredExplicitPartialJobsPreserveTheAcceptedConversionPath() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            addSecondSourceAndFillers(endpoint); JsonObject second=secondConversion(endpoint);
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            JsonObject result=endpoint.execute(envelope(endpoint.convert)); assertEquals(result.toString(),"committed",status(result));
            Set<Quad> after=all(endpoint.data); assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert)))); assertEquals(after,all(endpoint.data));
            JsonObject secondResult=endpoint.execute(second); assertEquals(secondResult.toString(),"committed",status(secondResult));
        }
    }
    /** Observe decoded bytes from actual consumed native index rows, not output payload sizes. */
    private static long[] physical(DatasetGraph data) {
        var storage=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data));
        var nodes=storage.getQuadTable().getNodeTupleTable().getNodeTable(); var table=storage.getQuadTable().getNodeTupleTable().getTupleTable();
        long[] reads={0,0,0,0,0,0,0,0,0};
        java.util.function.Consumer<Node[]> bytes=quad-> {
            Node graph=quad[0],predicate=quad[1],object=quad[2];
            long size=NodeFmtLib.strNT(predicate).getBytes(StandardCharsets.UTF_8).length+NodeFmtLib.strNT(object).getBytes(StandardCharsets.UTF_8).length;
            reads[2]+=size;
            if(graph.equals(uri(TemplateIndexService.STATE))) {
                if(predicate.equals(p("inventoryCheckpoint"))) { reads[3]+=size; reads[4]++; }
                if(predicate.equals(p("claimFoldConversionCheckpoint"))) { reads[3]+=size; reads[5]++; }
                if(predicate.equals(p("claimFoldMemberConstruction"))) { reads[6]+=size; reads[7]++; }
                if(predicate.equals(p("claimFoldDirectorySeal"))) { reads[6]+=size; reads[8]++; }
            }
        };
        for(String name:List.of("GPOS","GSPO")) {
            var original=table.selectIndex(name); var base=(org.apache.jena.tdb2.store.tupletable.TupleIndexRecord)original.baseTupleIndex();
            var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
                (proxy,method,args)->{
                    Object result=method.invoke(base.getRangeIndex(),args);
                    return method.getName().equals("iterator")?Iter.map((Iterator<?>)result,row->{
                        reads[name.equals("GPOS")?0:1]++;
                        if(name.equals("GSPO")&&row instanceof org.apache.jena.dboe.base.record.Record record)
                            bytes.accept(new Node[]{nodes.getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(record.getKey(),0)),nodes.getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(record.getKey(),16)),nodes.getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(record.getKey(),24))});
                        return row;
                    }):result;
                });
            var counted=new org.apache.jena.tdb2.store.tupletable.TupleIndexRecord(4,original.getMapping(),name,range.getRecordFactory(),range);
            var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},
                (proxy,method,args)->{
                    if(method.getName().equals("baseTupleIndex")) return counted;
                    Object result=method.invoke(original,args);
                    return method.getName().equals("find")&&result instanceof Iterator<?>?Iter.map((Iterator<?>)result,row->{
                        reads[name.equals("GPOS")?0:1]++;
                        if(name.equals("GSPO")&&row instanceof org.apache.jena.atlas.lib.tuple.Tuple<?> tuple)
                            bytes.accept(new Node[]{nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(0)),nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(2)),nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(3))});
                        return row;
                    }):result;
                });
            for(int i=0;i<table.numIndexes();i++) if(table.getIndex(i)==original) table.setTupleIndex(i,observed);
        }
        return reads;
    }
    private static List<Long> measured(Endpoint endpoint,long[] reads,JsonObject request,String expected) throws Exception {
        Arrays.fill(reads,0); JsonObject result=endpoint.execute(request);
        return physicalCost(reads,result,expected);
    }
    private static List<Long> physicalCost(long[] reads,JsonObject result,String expected) {
        List<Long> cost=List.of(reads[0],reads[1],reads[2],reads[3],reads[4],reads[5]); assertEquals(result.toString(),expected,status(result));
        assertTrue("fixed native step exceeded 128 physical GPOS rows: "+cost,reads[0]<=128);
        assertTrue("fixed native step exceeded 640 physical GSPO rows: "+cost,reads[1]<=640);
        long byteLimit=expected.equals("committed")?256L*1024:128L*1024;
        assertTrue("fixed native step exceeded decoded point-read byte envelope "+byteLimit+": "+cost,reads[2]<=byteLimit);
        return cost;
    }
    private static long metadataWidth(Endpoint endpoint,Node subject,Node predicate) {
        endpoint.data.begin(ReadWrite.READ);
        try { return NodeFmtLib.strNT(predicate).getBytes(StandardCharsets.UTF_8).length+NodeFmtLib.strNT(one(endpoint.data,uri(TemplateIndexService.STATE),subject,predicate)).getBytes(StandardCharsets.UTF_8).length; }
        finally { endpoint.data.end(); }
    }
    private static void metadataCost(List<Long> cost,long checkpointWidth,long progressWidth) {
        assertEquals("consumed metadata bytes must equal exact retained checkpoint/progress widths times observed reads",cost.get(4)*checkpointWidth+cost.get(5)*progressWidth,cost.get(3).longValue());
    }
    private static List<Long> retainedCost(long[] reads,JsonObject result) {
        var bounded=physicalCost(reads,result,"retained"); List<Long> cost=new ArrayList<>(bounded); cost.addAll(List.of(reads[6],reads[7],reads[8]));
        assertTrue("retained step exceeds its fixed point footprint: "+cost,reads[1]<=512); assertTrue("retained step exceeds64KiB decoded point bytes: "+cost,reads[2]<=64L*1024);
        return List.copyOf(cost);
    }
    private static void directoryMetadataCost(List<Long> cost,long constructionWidth,long sealWidth) {
        assertEquals("directory metadata must match exact retained construction/seal widths times observed reads",cost.get(7)*constructionWidth+cost.get(8)*sealWidth,cost.get(6).longValue());
    }
    @Test public void sealedInventoryPermitsSuccessiveConversionsAndReadOnlyExactPerClaimDispositionsUnderGrowth() throws Exception {
        List<List<Long>> baseline=null;
        for(int growth:List.of(0,4097)) {
            try(Endpoint endpoint=new Endpoint(false,growth)) {
                addSecondSourceAndFillers(endpoint,growth==0?127:3501); JsonObject second=secondConversion(endpoint);
                assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
                String attempt=UUID.randomUUID().toString(),previous=""; int ordinal=0; JsonObject source;
                Map<String,JsonObject> rows=new HashMap<>();
                do {
                    source=endpoint.execute(inventory(endpoint,attempt,ordinal++,previous)); assertEquals(source.toString(),"committed",status(source));
                    for(JsonValue row:source.get("rows").getAsArray()) rows.put(row.getAsObject().get("claim").getAsString().value(),row.getAsObject());
                    previous=source.get("hash").getAsString().value();
                } while(!source.get("sourceComplete").getAsBoolean().value());
                assertEquals(growth==0?129:3503,source.get("total").getAsNumber().value().intValue());
                JsonObject firstRead=disposition(endpoint,source,Objects.requireNonNull(rows.get(id(1).getURI())));
                JsonObject secondRead=disposition(endpoint,source,Objects.requireNonNull(rows.get(id(500).getURI())));
                Node header=uri(firstRead.get("claimFoldDisposition").getAsObject().get("job").getAsObject().get("marker").getAsString().value()+":inventory");
                endpoint.data.begin(ReadWrite.READ); Set<Quad> sealedHeader;
                try { sealedHeader=record(endpoint.data,uri(TemplateIndexService.STATE),header); }
                finally { endpoint.data.end(); }
                long checkpointWidth=metadataWidth(endpoint,header,p("inventoryCheckpoint")); Node progress=uri(header.getURI()+":conversions");
                long[] reads=physical(endpoint.raw); List<List<Long>> costs=new ArrayList<>();
                Set<Quad> before=all(endpoint.data); long beforeVersion=version(endpoint.raw);
                costs.add(measured(endpoint,reads,firstRead,"unresolved")); assertEquals(before,all(endpoint.data)); assertEquals(beforeVersion,version(endpoint.raw));
                metadataCost(costs.getLast(),checkpointWidth,0);
                costs.add(measured(endpoint,reads,envelope(endpoint.convert),"committed"));
                metadataCost(costs.getLast(),checkpointWidth,0);
                long firstProgressWidth=metadataWidth(endpoint,progress,p("claimFoldConversionCheckpoint"));
                JsonObject firstDisposition=endpoint.execute(firstRead);
                assertEquals(firstDisposition.toString(),"converted",status(firstDisposition)); assertEquals(receipt(endpoint.convert),firstDisposition.get("receipt").getAsString().value());
                for(String key:List.of("claim","head","witness","sourceCut")) assertEquals(firstRead.get("claimFoldDisposition").getAsObject().get(key),firstDisposition.get(key));
                assertEquals(source.get("hash"),firstDisposition.get("seal"));
                Set<Quad> firstCommitted=all(endpoint.data); long firstVersion=version(endpoint.raw);
                costs.add(measured(endpoint,reads,firstRead,"converted")); assertEquals(firstCommitted,all(endpoint.data)); assertEquals(firstVersion,version(endpoint.raw));
                metadataCost(costs.getLast(),checkpointWidth,firstProgressWidth);
                assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert)))); assertEquals(firstCommitted,all(endpoint.data)); assertEquals(firstVersion,version(endpoint.raw));
                for(String key:List.of("head","witness","sourceCut","seal")) {
                    JsonObject wrong=JSON.parse(firstRead.toString()); wrong.get("claimFoldDisposition").getAsObject().put(key,key.equals("head")?id(999).getURI():"0".repeat(64));
                    assertEquals("invalid",status(endpoint.execute(wrong))); assertEquals(firstCommitted,all(endpoint.data)); assertEquals(firstVersion,version(endpoint.raw));
                }
                for(String key:List.of("claim","job")) {
                    JsonObject wrong=JSON.parse(firstRead.toString()); JsonObject input=wrong.get("claimFoldDisposition").getAsObject();
                    if(key.equals("claim")) input.put("claim",id(20000).getURI()); else input.get("job").getAsObject().put("job","another-owned-job");
                    assertEquals("invalid",status(endpoint.execute(wrong))); assertEquals(firstCommitted,all(endpoint.data)); assertEquals(firstVersion,version(endpoint.raw));
                }
                String duplicateDigest=sha("duplicate new receipt for already converted C");
                JsonObject duplicate=JSON.parse(envelope(endpoint.convert).toString()); duplicate.put("receipt",PREFIX+"convert:"+duplicateDigest); duplicate.put("digest",duplicateDigest);
                duplicate.put("update",update(endpoint.convert).replace((String)field(endpoint.convert,"digest"),duplicateDigest));
                JsonObject duplicateResult=endpoint.execute(duplicate); assertEquals(duplicateResult.toString(),"invalid",status(duplicateResult));
                assertTrue("new receipt cannot renew the converted member",duplicateResult.toString().contains("already converted"));
                assertEquals(firstCommitted,all(endpoint.data)); assertEquals(firstVersion,version(endpoint.raw));
                costs.add(measured(endpoint,reads,second,"committed"));
                metadataCost(costs.getLast(),checkpointWidth,firstProgressWidth);
                long secondProgressWidth=metadataWidth(endpoint,progress,p("claimFoldConversionCheckpoint"));
                JsonObject secondDisposition=endpoint.execute(secondRead); assertEquals(secondDisposition.toString(),"converted",status(secondDisposition));
                assertEquals(second.get("receipt"),secondDisposition.get("receipt"));
                Set<Quad> secondCommitted=all(endpoint.data); long secondVersion=version(endpoint.raw);
                costs.add(measured(endpoint,reads,secondRead,"converted")); assertEquals(secondCommitted,all(endpoint.data)); assertEquals(secondVersion,version(endpoint.raw));
                metadataCost(costs.getLast(),checkpointWidth,secondProgressWidth);
                assertEquals(firstDisposition.toString(),endpoint.execute(firstRead).toString());
                for(JsonObject command:List.of(envelope(endpoint.convert),second)) {
                    assertEquals("committed",status(endpoint.execute(command))); assertEquals(secondCommitted,all(endpoint.data)); assertEquals(secondVersion,version(endpoint.raw));
                }
                JsonObject retainedRead=disposition(endpoint,source,Objects.requireNonNull(rows.get(id(20000).getURI())));
                assertEquals("an inventoried retained Claim must not become terminal merely because other Claims converted","unresolved",status(endpoint.execute(retainedRead)));
                assertEquals(secondCommitted,all(endpoint.data)); assertEquals(secondVersion,version(endpoint.raw));
                for(String phase:List.of("complete","release")) {
                    String oldDigest=(String)field(endpoint.acquire,"digest"),digest=sha("unqualified "+phase);
                    String terminalUpdate=update(endpoint.acquire).replace(":acquire:",":"+phase+":").replace("fold-acquire-v1","fold-"+phase+"-v1").replace(oldDigest,digest);
                    var denied=endpoint.post(envelope(PREFIX+phase+":"+digest,digest,terminalUpdate,null),"1".repeat(64));
                    if(denied.statusCode()==200) assertEquals(denied.body(),"invalid",status(JSON.parse(denied.body())));
                    else assertEquals(denied.body(),400,denied.statusCode());
                    assertTrue("terminal refusal must require exhaustive reconciliation: "+denied.body(),denied.body().contains("exhaustive reconciled inventory"));
                    assertEquals(secondCommitted,all(endpoint.data)); assertEquals(secondVersion,version(endpoint.raw));
                }
                endpoint.data.begin(ReadWrite.READ);
                try {
                    assertEquals("the original sealed checkpoint must stay immutable",sealedHeader,record(endpoint.data,uri(TemplateIndexService.STATE),header));
                    for(Node claim:List.of(id(1),id(500))) { assertTrue(endpoint.data.contains(CURRENT,claim,RDF.type.asNode(),RDF.Statement.asNode())); assertTrue(endpoint.data.contains(REVISIONS,claim,RDF.type.asNode(),p("Claim"))); }
                    assertEquals("100",CommandInvariant.readControl(endpoint.data).sequence().toString());
                } finally { endpoint.data.end(); }
                if(baseline==null) baseline=costs; else for(int i=0;i<costs.size();i++) {
                    List<Long> small=baseline.get(i),large=costs.get(i);
                    assertEquals("inventory/assessment growth changed physical tuple counts",small.subList(0,2),large.subList(0,2));
                    assertEquals("growth changed checkpoint/progress read multiplicity",small.subList(4,6),large.subList(4,6));
                    assertEquals("growth changed decoded bytes outside exact checkpoint/progress metadata",small.get(2)-small.get(3),large.get(2)-large.get(3));
                    assertEquals("total byte growth must be exactly the measured retained metadata width delta",large.get(3)-small.get(3),large.get(2)-small.get(2));
                }
                System.out.println("claim-fold command inventory="+rows.size()+" assessments="+growth+" unrelatedTypedClaims="+growth+" GPOS/GSPO/decodedBytes/metadataBytes/checkpointReads/progressReads steps="+costs);
            }
        }
    }
    @Test public void restoredNativeStoreCannotRenewASealButExactHistoricalConversionReplayRemainsReadOnly() throws Exception {
        Set<Quad> restored; JsonObject second,firstRead; long savedVersion;
        try(Endpoint endpoint=new Endpoint()) {
            addSecondSourceAndFillers(endpoint); second=secondConversion(endpoint);
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            String attempt=UUID.randomUUID().toString(); JsonObject first=endpoint.execute(inventory(endpoint,attempt,0,""));
            JsonObject last=endpoint.execute(inventory(endpoint,attempt,1,first.get("hash").getAsString().value()));
            JsonObject row=null;
            for(JsonObject page:List.of(first,last)) for(JsonValue item:page.get("rows").getAsArray()) if(item.getAsObject().get("claim").getAsString().value().equals(id(1).getURI())) row=item.getAsObject();
            firstRead=disposition(endpoint,last,Objects.requireNonNull(row));
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            assertEquals("converted",status(endpoint.execute(firstRead))); restored=all(endpoint.data); savedVersion=version(endpoint.raw);
        }
        // Actual TDB2 node table and transaction system are new; all logical source and private proof bytes are copied unchanged.
        try(Endpoint endpoint=new Endpoint(false,0,restored)) {
            Node temporary=uri("urn:test:restored-store-version-alignment");
            assertTrue("fixture needs at least two actual commits to align the restored version",savedVersion-version(endpoint.raw)>=2);
            while(version(endpoint.raw)<savedVersion) {
                long current=version(endpoint.raw);
                endpoint.data.begin(ReadWrite.WRITE);
                try {
                    endpoint.data.deleteAny(CONTROL,temporary,p("temporary"),Node.ANY);
                    if(current+1<savedVersion) endpoint.data.add(CONTROL,temporary,p("temporary"),NodeFactory.createLiteralString("version-"+current));
                    endpoint.data.commit();
                } finally { endpoint.data.end(); }
            }
            assertEquals("all original logical bytes must survive version alignment",restored,all(endpoint.data));
            assertEquals("incarnation refusal must be independent of version mismatch",savedVersion,version(endpoint.raw));
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject denied=endpoint.execute(second); assertEquals(denied.toString(),"invalid",status(denied)); assertTrue(denied.toString().contains("inventory"));
            assertEquals("invalid",status(endpoint.execute(firstRead)));
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    @Test public void authenticatedMemberDirectoryPagesTheImmutableInventoryAndPreservesConvertedMembers() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            addSecondSourceAndFillers(endpoint); assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            String attempt=UUID.randomUUID().toString(); JsonObject first=endpoint.execute(inventory(endpoint,attempt,0,""));
            JsonObject source=endpoint.execute(inventory(endpoint,attempt,1,first.get("hash").getAsString().value()));
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject request=members(endpoint,source,"");
            JsonObject page=endpoint.execute(request); assertEquals(page.toString(),"read",status(page)); assertEquals(127,page.get("rows").getAsArray().size()); assertFalse(page.get("directoryEOF").getAsBoolean().value());
            assertEquals("lost HTTP acknowledgment must yield the exact same directory slice",page.toString(),endpoint.execute(request).toString());
            JsonObject last=endpoint.execute(members(endpoint,source,page.get("progress").getAsString().value()));
            assertEquals(last.toString(),"read",status(last)); assertTrue(last.get("directoryEOF").getAsBoolean().value()); assertEquals("",last.get("progress").getAsString().value()); assertEquals(129,last.get("count").getAsNumber().value().intValue());
            Map<String,String> original=new HashMap<>();
            for(JsonObject slice:List.of(page,last)) for(JsonValue row:slice.get("rows").getAsArray()) assertNull(original.put(row.getAsObject().get("claim").getAsString().value(),row.toString()));
            assertEquals(129,original.size()); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            Set<Quad> converted=all(endpoint.data); long convertedVersion=version(endpoint.raw); String progress=""; Map<String,String> retained=new HashMap<>();
            do {
                JsonObject slice=endpoint.execute(members(endpoint,source,progress)); assertEquals(slice.toString(),"read",status(slice));
                for(JsonValue row:slice.get("rows").getAsArray()) assertNull(retained.put(row.getAsObject().get("claim").getAsString().value(),row.toString()));
                progress=slice.get("progress").getAsString().value();
            } while(!progress.isEmpty());
            assertEquals("conversion cannot remove or rewrite an original directory member",original,retained); assertEquals(converted,all(endpoint.data)); assertEquals(convertedVersion,version(endpoint.raw));
        }
    }
    @Test public void outsidePredicateRetentionPreservesSourceCustodyAndReplaysReadOnlyAcrossGrowthAndStorageChanges() throws Exception {
        List<List<Long>> baseline=null; JsonObject historicalRequest=null,historicalResult=null; Set<Quad> restored=null;
        for(int growth:List.of(0,4097)) try(Endpoint endpoint=new Endpoint(false,growth)) {
            addSecondSourceAndFillers(endpoint,growth==0?127:3501); outsidePredicate(endpoint,""); RetainedSource source=captureRetainedSource(endpoint); JsonObject request=retain(endpoint,source);
            Set<Quad> before=all(endpoint.data); Node header=uri(request.get("claimFoldRetain").getAsObject().get("job").getAsObject().get("marker").getAsString().value()+":inventory");
            long checkpointWidth=metadataWidth(endpoint,header,p("inventoryCheckpoint")),constructionWidth=metadataWidth(endpoint,uri(header.getURI()+":members:construction"),p("claimFoldMemberConstruction")),sealWidth=metadataWidth(endpoint,uri(header.getURI()+":members:seal:"+source.source().get("attempt").getAsString().value()),p("claimFoldDirectorySeal"));
            long[] reads=physical(endpoint.raw); List<List<Long>> costs=new ArrayList<>();
            Arrays.fill(reads,0); JsonObject retained=endpoint.execute(request); costs.add(retainedCost(reads,retained)); metadataCost(costs.getLast(),checkpointWidth,0); directoryMetadataCost(costs.getLast(),constructionWidth,sealWidth);
            assertTrue(retained.toString(),retained.get("receipt").getAsString().value().matches("urn:rezics:claim-fold-retained:[0-9a-f]{64}"));
            assertEquals("https://schema.org/dateCreated",retained.get("predicate").getAsString().value()); assertTrue(retained.get("sourceDigest").getAsString().value().matches("[0-9a-f]{64}"));
            Set<Quad> after=all(endpoint.data); long version=version(endpoint.raw);
            for(Quad quad:before) assertTrue("retention changed original custody: "+quad,after.contains(quad));
            assertEquals(before.stream().filter(quad->!quad.getGraph().equals(uri(TemplateIndexService.STATE))&&!quad.getGraph().equals(RECEIPTS)).collect(java.util.stream.Collectors.toSet()),after.stream().filter(quad->!quad.getGraph().equals(uri(TemplateIndexService.STATE))&&!quad.getGraph().equals(RECEIPTS)).collect(java.util.stream.Collectors.toSet()));
            endpoint.data.begin(ReadWrite.READ);
            try { assertEquals("100",CommandInvariant.readControl(endpoint.data).sequence().toString()); assertTrue(endpoint.data.contains(CURRENT,id(1),RDF.type.asNode(),p("Claim"))); assertTrue(endpoint.data.contains(RECEIPTS,uri(retained.get("receipt").getAsString().value()),RDF.type.asNode(),p("OperationReceipt"))); }
            finally { endpoint.data.end(); }
            JsonObject read=disposition(endpoint,source.source(),source.row()); Arrays.fill(reads,0); JsonObject readResult=endpoint.execute(read); costs.add(retainedCost(reads,readResult)); directoryMetadataCost(costs.getLast(),constructionWidth,sealWidth);
            metadataCost(costs.getLast(),checkpointWidth,metadataWidth(endpoint,uri(header.getURI()+":conversions"),p("claimFoldConversionCheckpoint")));
            assertEquals(retained.toString(),endpoint.execute(request).toString()); assertEquals(after,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            JsonObject expired=JSON.parse(request.toString()); expired.get("claimFoldRetain").getAsObject().put("deadline",1);
            assertEquals("expired exact replay must not renew source authority",retained.toString(),endpoint.execute(expired).toString()); assertEquals(after,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            JsonObject convertDenied=endpoint.execute(envelope(endpoint.convert)); assertEquals(convertDenied.toString(),"invalid",status(convertDenied)); assertTrue(convertDenied.toString(),convertDenied.toString().contains("retained")); assertEquals(after,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            if(baseline==null) baseline=costs; else for(int i=0;i<costs.size();i++) {
                assertEquals(baseline.get(i).subList(0,2),costs.get(i).subList(0,2)); assertEquals(baseline.get(i).subList(4,6),costs.get(i).subList(4,6));
                assertEquals("retention growth changed directory-proof read multiplicity",baseline.get(i).subList(7,9),costs.get(i).subList(7,9));
                assertEquals("retention growth changed non-metadata bytes",baseline.get(i).get(2)-baseline.get(i).get(3)-baseline.get(i).get(6),costs.get(i).get(2)-costs.get(i).get(3)-costs.get(i).get(6));
                assertEquals("retention total growth must exactly match measured metadata widths",costs.get(i).get(3)-baseline.get(i).get(3)+costs.get(i).get(6)-baseline.get(i).get(6),costs.get(i).get(2)-baseline.get(i).get(2));
            }
            System.out.println("claim retained inventory="+(growth==0?129:3503)+" assessments/typedClaimRevisions="+growth+" GPOS/GSPO/bytes/checkpointMetadata/checkpointReads/progressReads/directoryMetadata/constructionReads/sealReads="+costs);
            endpoint.data.begin(ReadWrite.WRITE); try { endpoint.data.add(CONTROL,uri("urn:retention:foreign"),p("heartbeat"),NodeFactory.createLiteralString("foreign commit")); endpoint.data.commit(); } finally { endpoint.data.end(); }
            Set<Quad> foreign=all(endpoint.data); long foreignVersion=version(endpoint.raw); assertEquals("invalid",status(endpoint.execute(read)));
            JsonObject changed=JSON.parse(request.toString()); changed.get("claimFoldRetain").getAsObject().put("head",id(999).getURI()); changed.get("claimFoldRetain").getAsObject().put("deadline",System.currentTimeMillis()+30_000); assertEquals("unresolved",status(endpoint.execute(changed)));
            assertEquals(retained.toString(),endpoint.execute(request).toString()); assertEquals(foreign,all(endpoint.data)); assertEquals(foreignVersion,version(endpoint.raw));
            if(growth==0) { historicalRequest=request; historicalResult=retained; restored=foreign; }
        }
        try(Endpoint endpoint=new Endpoint(false,0,Objects.requireNonNull(restored))) {
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            assertEquals(Objects.requireNonNull(historicalResult).toString(),endpoint.execute(Objects.requireNonNull(historicalRequest)).toString());
            JsonObject changed=JSON.parse(historicalRequest.toString()); changed.get("claimFoldRetain").getAsObject().put("head",id(999).getURI()); changed.get("claimFoldRetain").getAsObject().put("deadline",System.currentTimeMillis()+30_000); assertEquals("unresolved",status(endpoint.execute(changed)));
            JsonObject lookup=new JsonObject(),input=new JsonObject();
            for(String key:List.of("job","sourceCut","seal","claim","head","witness")) input.put(key,historicalRequest.get("claimFoldRetain").getAsObject().get(key));
            input.put("deadline",System.currentTimeMillis()+30_000); lookup.put("claimFoldDisposition",input); assertEquals("invalid",status(endpoint.execute(lookup)));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    @Test public void refusedRetentionInputsRemainUnresolvedAndCannotOverwriteConvertedMembers() throws Exception {
        for(String defect:List.of("inside-predicate","predicate-mismatch","unknown-value","missing-value","uncertain-precision","ambiguous-history","missing-speaker","invalid-recordedAt","oversized-definition","default-definition","missing-receipt","missing-blob","bad-sealed-payload","wrong-witness")) try(Endpoint endpoint=new Endpoint()) {
            outsidePredicate(endpoint,defect); RetainedSource source=captureRetainedSource(endpoint); JsonObject request=retain(endpoint,source);
            if(defect.equals("missing-blob")) request.get("claimFoldRetain").getAsObject().put("relationPayload","");
            if(defect.equals("bad-sealed-payload")) request.get("claimFoldRetain").getAsObject().put("qualificationPayload",request.get("claimFoldRetain").getAsObject().get("qualificationPayload").getAsString().value()+" ");
            if(defect.equals("wrong-witness")) request.get("claimFoldRetain").getAsObject().put("witness","0".repeat(64));
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject result=endpoint.execute(request); assertEquals(defect+": "+result,"unresolved",status(result));
            if(defect.equals("oversized-definition")) assertTrue("oversized native scalar must fail before numeric/hash work: "+result,result.toString().contains("byte bound"));
            assertEquals("unresolved",status(endpoint.execute(disposition(endpoint,source.source(),source.row())))); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
        try(Endpoint endpoint=new Endpoint()) {
            RetainedSource source=captureRetainedSource(endpoint); assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert)))); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            assertEquals("unresolved",status(endpoint.execute(retain(endpoint,source)))); assertEquals("converted",status(endpoint.execute(disposition(endpoint,source.source(),source.row())))); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    @Test public void cancellationAfterTheActualRetainedDispositionWriteRollsBackReceiptAndSourceProgressTogether() throws Exception {
        try(Endpoint endpoint=new Endpoint(p("claimFoldRetainedDisposition"))) {
            outsidePredicate(endpoint,""); RetainedSource source=captureRetainedSource(endpoint); JsonObject request=retain(endpoint,source); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject result=endpoint.execute(request); assertTrue("retained disposition must be staged before cancellation",endpoint.interrupted.get()); assertEquals(result.toString(),"deadline",status(result));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); assertEquals("unresolved",status(endpoint.execute(disposition(endpoint,source.source(),source.row()))));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    private static Node nativeRetainedReceipt(JsonObject envelope) {
        try {
            var request=ClaimFoldInventory.parseRetain(JSON.toStringFlat(envelope).getBytes(StandardCharsets.UTF_8));
            Method digest=ClaimFoldInventory.class.getDeclaredMethod("retainDigest",ClaimFoldInventory.RetainRequest.class); digest.setAccessible(true);
            return uri("urn:rezics:claim-fold-retained:"+digest.invoke(null,request));
        } catch(ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    @Test public void orphanReceiptsAndLateSourceOrReceiptChangesCannotPublishRetainedDispositions() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            outsidePredicate(endpoint,""); RetainedSource source=captureRetainedSource(endpoint); JsonObject request=retain(endpoint,source); Node own=nativeRetainedReceipt(request);
            endpoint.data.begin(ReadWrite.WRITE);
            try {
                endpoint.data.add(RECEIPTS,own,p("unreviewed"),NodeFactory.createLiteralString("orphan receipt exists"));
                // Isolate receipt freshness under stopped private-state tampering; a mere foreign-version refusal does not prove this guard.
                Node header=uri(request.get("claimFoldRetain").getAsObject().get("job").getAsObject().get("marker").getAsString().value()+":inventory");
                JsonObject checkpoint=JSON.parse(one(endpoint.data,uri(TemplateIndexService.STATE),header,p("inventoryCheckpoint")).getLiteralLexicalForm());
                checkpoint.put("version",org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion()+1);
                endpoint.data.deleteAny(uri(TemplateIndexService.STATE),header,p("inventoryCheckpoint"),Node.ANY); endpoint.data.add(uri(TemplateIndexService.STATE),header,p("inventoryCheckpoint"),NodeFactory.createLiteralString(JSON.toStringFlat(checkpoint))); endpoint.data.commit();
            } finally { endpoint.data.end(); }
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject refused=endpoint.execute(request);
            assertEquals(refused.toString(),"unresolved",status(refused)); assertTrue("receipt must be refused independently of version mismatch: "+refused,refused.toString().contains("receipt"));
            assertEquals("unresolved",status(endpoint.execute(disposition(endpoint,source.source(),source.row())))); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
        for(String mutation:List.of("source","receipt")) {
            var own=new java.util.concurrent.atomic.AtomicReference<Node>();
            try(Endpoint endpoint=new Endpoint(data->{
                if(mutation.equals("source")) { data.deleteAny(REVISIONS,id(2),p("recordedAt"),Node.ANY); data.add(REVISIONS,id(2),p("recordedAt"),NodeFactory.createLiteralString("late observer changed original provenance")); }
                else data.add(RECEIPTS,Objects.requireNonNull(own.get()),p("unreviewed"),NodeFactory.createLiteralString("late observer appended receipt field"));
            })) {
                outsidePredicate(endpoint,""); RetainedSource source=captureRetainedSource(endpoint); JsonObject request=retain(endpoint,source); own.set(nativeRetainedReceipt(request));
                Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject refused=endpoint.execute(request);
                assertTrue("actual retained disposition must be staged before late mutation",endpoint.lateMutation.get()); assertEquals(mutation+": "+refused,"unresolved",status(refused));
                assertEquals("late source, receipt, disposition and progress mutations must abort together",before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); assertEquals("unresolved",status(endpoint.execute(disposition(endpoint,source.source(),source.row()))));
                assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            }
        }
    }
    private static void classifyBounds(JsonObject result,long[] actual) {
        assertTrue("all native returned tuples including default/lookahead exceeded512: "+Arrays.toString(actual),actual[0]<=512);
        assertTrue("all native index probes exceeded128: "+Arrays.toString(actual),actual[1]<=128);
        assertTrue("all independently decoded tuple bytes exceeded256KiB: "+Arrays.toString(actual),actual[2]<=256L*1024);
        JsonObject work=result.get("work").getAsObject(); assertTrue(work.get("tuples").getAsNumber().value().intValue()<=512); assertTrue(work.get("probes").getAsNumber().value().intValue()<=128); assertTrue(work.get("bytes").getAsNumber().value().intValue()<=256*1024);
    }
    @Test public void classifierExhausts129NativeConvertedAndRetainedDispositionsWithoutWritesOrCompletionAuthority() throws Exception {
        List<List<Long>> baseline=null;
        for(int growth:List.of(0,5000)) {
        long started=System.currentTimeMillis(); try(Endpoint endpoint=new Endpoint()) {
            classificationNoise(endpoint,growth);
            addClassificationSources(endpoint,128); RetainedSource captured=captureRetainedSource(endpoint); Map<String,JsonObject> original=sourceRows(endpoint,captured.source()); assertEquals(129,original.size());
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            for(int i=0;i<128;i++) { JsonObject row=Objects.requireNonNull(original.get(id(500+i*2).getURI())); JsonObject result=endpoint.execute(retain(endpoint,new RetainedSource(captured.source(),row))); assertEquals(result.toString(),"retained",status(result)); }
            JsonObject memberPage=endpoint.execute(members(endpoint,captured.source(),"")); assertFalse(memberPage.get("progress").getAsString().value().isEmpty());
            unresolvedClassify(endpoint.execute(classify(endpoint,captured.source(),memberPage.get("progress").getAsString().value())));
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); long[] actual=classifierPhysical(endpoint.raw,()->{}); String progress=""; long count=0; int turns=0; JsonObject last=null; long maxTuples=0,maxProbes=0,maxBytes=0; List<List<Long>> costs=new ArrayList<>();
            do {
                String submitted=progress; Arrays.fill(actual,0); last=endpoint.execute(classify(endpoint,captured.source(),submitted)); assertEquals(last.toString(),"classified",status(last)); classifyBounds(last,actual);
                costs.add(List.of(actual[0],actual[1],actual[2]));
                maxTuples=Math.max(maxTuples,actual[0]); maxProbes=Math.max(maxProbes,actual[1]); maxBytes=Math.max(maxBytes,actual[2]);
                long next=last.get("count").getAsNumber().value().longValue(); assertTrue("each bounded turn must make progress through at most two members",next>count&&next-count<=2); count=next;
                assertEquals(count,last.get("converted").getAsNumber().value().longValue()+last.get("retained").getAsNumber().value().longValue()); assertEquals(version,last.get("snapshotVersion").getAsNumber().value().longValue());
                assertTrue(last.get("transcript").getAsString().value().matches("[0-9a-f]{64}")); assertEquals(captured.source().get("sourceCut"),last.get("sourceCut")); assertEquals(captured.source().get("hash"),last.get("seal"));
                assertEquals("read lost ack must reproduce the exact classifier transcript",last.toString(),endpoint.execute(classify(endpoint,captured.source(),submitted)).toString());
                assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); progress=last.get("progress").getAsString().value(); assertEquals(progress.isEmpty(),last.get("classificationEOF").getAsBoolean().value()); assertTrue(++turns<=129);
            } while(!progress.isEmpty());
            assertNotNull(last); assertEquals(129,count); assertEquals(1,last.get("converted").getAsNumber().value().intValue()); assertEquals(128,last.get("retained").getAsNumber().value().intValue()); assertTrue("more than128 members must require multiple native bounded turns",turns>=65);
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); assertTrue("native fixture preparation/classification exceeded nine minutes",System.currentTimeMillis()-started<540_000);
            if(baseline==null) baseline=costs; else assertEquals("same-job acknowledgment and unrelated default growth changed classifier physical work",baseline,costs);
            System.out.println("claim classification nativeConverted=1 nativeRetained=128 unrelatedAcks/defaults="+growth+" turns="+turns+" maxAllIndexTuples/probes/decodedBytes="+List.of(maxTuples,maxProbes,maxBytes)+" elapsedMs="+(System.currentTimeMillis()-started));
        }
        }
    }
    private static void unresolvedClassify(JsonObject result) {
        assertEquals(result.toString(),"unresolved",status(result)); assertFalse("refusal cannot attest EOF",result.hasKey("classificationEOF")); assertFalse("refusal cannot advance current cursor",result.hasKey("progress"));
    }
    @Test public void classifierRefusesMissingOverlapCorruptReceiptsWrongPurposeAndStaleStorageAndCancelsReadOnly() throws Exception {
        for(String defect:List.of("missing","overlap","native-receipt","original-receipt","wrong-source","default-source","budget")) try(Endpoint endpoint=new Endpoint()) {
            RetainedSource source=captureRetainedSource(endpoint); assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            endpoint.data.begin(ReadWrite.WRITE);
            try {
                Node header=uri(inventory(endpoint,UUID.randomUUID().toString(),0,"").get("claimFoldInventory").getAsObject().get("job").getAsObject().get("marker").getAsString().value()+":inventory");
                Node disposition=uri(header.getURI()+":converted:"+sha(id(1).getURI()));
                if(defect.equals("missing")) endpoint.data.deleteAny(uri(TemplateIndexService.STATE),disposition,p("claimFoldDisposition"),Node.ANY);
                if(defect.equals("overlap")) endpoint.data.add(uri(TemplateIndexService.STATE),uri(header.getURI()+":retained:"+sha(id(1).getURI())),p("claimFoldRetainedDisposition"),NodeFactory.createLiteralString("{}"));
                if(defect.equals("native-receipt")) endpoint.data.deleteAny(RECEIPTS,uri(receipt(endpoint.convert)),p("outcome"),Node.ANY);
                if(defect.equals("original-receipt")) endpoint.data.deleteAny(RECEIPTS,uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create")),p("outcome"),Node.ANY);
                if(defect.equals("budget")) {
                    Node original=uri("urn:rezics:receipt:"+sha("00000000-0000-4000-8000-000000000050"+'\0'+"claim-create")); endpoint.data.deleteAny(RECEIPTS,original,p("requestDigest"),Node.ANY); endpoint.data.add(RECEIPTS,original,p("requestDigest"),NodeFactory.createLiteralString("a".repeat(300_000)));
                }
                if(defect.equals("wrong-source")) { endpoint.data.deleteAny(REVISIONS,id(2),p("component"),Node.ANY); endpoint.data.add(REVISIONS,id(2),p("component"),id(999)); }
                if(defect.equals("default-source")) endpoint.data.add(Quad.defaultGraphNodeGenerated,id(2),p("sequence"),NodeFactory.createLiteralDT("2",org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                Node progress=uri(header.getURI()+":conversions"); JsonObject state=JSON.parse(one(endpoint.data,uri(TemplateIndexService.STATE),progress,p("claimFoldConversionCheckpoint")).getLiteralLexicalForm()); state.put("version",org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion()+1);
                endpoint.data.deleteAny(uri(TemplateIndexService.STATE),progress,p("claimFoldConversionCheckpoint"),Node.ANY); endpoint.data.add(uri(TemplateIndexService.STATE),progress,p("claimFoldConversionCheckpoint"),NodeFactory.createLiteralString(JSON.toStringFlat(state))); endpoint.data.commit();
            } finally { endpoint.data.end(); }
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); long[] actual=classifierPhysical(endpoint.raw,()->{}); Arrays.fill(actual,0); JsonObject refused=endpoint.execute(classify(endpoint,source.source(),""));
            if(defect.equals("budget")) {
                assertEquals(refused.toString(),"budget",status(refused)); assertFalse(refused.hasKey("classificationEOF")); assertFalse(refused.hasKey("progress"));
                assertTrue("actual malformed stored scalar exceeds the processing byte allowance",actual[2]>256L*1024);
            } else { unresolvedClassify(refused); assertTrue(Arrays.toString(actual),actual[2]<=256L*1024); }
            assertTrue(Arrays.toString(actual),actual[0]<=512&&actual[1]<=128); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
        try(Endpoint endpoint=new Endpoint()) {
            addClassificationSources(endpoint,2); RetainedSource source=captureRetainedSource(endpoint); Map<String,JsonObject> rows=sourceRows(endpoint,source.source()); assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            for(int i=0;i<2;i++) assertEquals("retained",status(endpoint.execute(retain(endpoint,new RetainedSource(source.source(),rows.get(id(500+i*2).getURI()))))));
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject first=endpoint.execute(classify(endpoint,source.source(),"")); assertEquals("classified",status(first)); String progress=first.get("progress").getAsString().value(); assertFalse(progress.isEmpty());
            var armed=new java.util.concurrent.atomic.AtomicBoolean(true); long[] actual=classifierPhysical(endpoint.raw,()->{ if(armed.compareAndSet(true,false)) Thread.currentThread().interrupt(); });
            JsonObject cancelled;
            try { cancelled=ClaimFoldInventory.classify(endpoint.raw,ClaimFoldInventory.parseClassify(JSON.toStringFlat(classify(endpoint,source.source(),progress)).getBytes(StandardCharsets.UTF_8))); } finally { Thread.interrupted(); }
            assertEquals(cancelled.toString(),"deadline",status(cancelled)); assertTrue(actual[0]>0); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            JsonObject resumed=endpoint.execute(classify(endpoint,source.source(),progress)); assertEquals("classified",status(resumed)); assertTrue(resumed.get("classificationEOF").getAsBoolean().value());
            try(Endpoint copied=new Endpoint(false,0,before)) {
                Set<Quad> copiedBefore=all(copied.data); long copiedVersion=version(copied.raw); unresolvedClassify(copied.execute(classify(copied,source.source(),progress))); unresolvedClassify(copied.execute(classify(copied,source.source(),""))); assertEquals(copiedBefore,all(copied.data)); assertEquals(copiedVersion,version(copied.raw));
            }
            endpoint.data.begin(ReadWrite.WRITE); try { endpoint.data.add(CONTROL,uri("urn:classifier:foreign"),p("heartbeat"),NodeFactory.createLiteralString("freshness changed")); endpoint.data.commit(); } finally { endpoint.data.end(); }
            Set<Quad> stale=all(endpoint.data); long staleVersion=version(endpoint.raw); unresolvedClassify(endpoint.execute(classify(endpoint,source.source(),progress))); unresolvedClassify(endpoint.execute(classify(endpoint,source.source(),""))); assertEquals(stale,all(endpoint.data)); assertEquals(staleVersion,version(endpoint.raw));
        }
    }
    @Test public void cancellationAfterTheRealDispositionWriteAbortsTheFinalCommitAndPreservesTheSourceSeal() throws Exception {
        cancellation(p("claimFoldDisposition"));
    }
    @Test public void cancellationAfterTheRealTemplateStampAlsoAbortsBeforeStagingDisposition() throws Exception {
        cancellation(ClaimStatementFoldPolicy.templateDigestPredicate());
    }
    private static void cancellation(Node cancellationPredicate) throws Exception {
        try(Endpoint endpoint=new Endpoint(cancellationPredicate)) {
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            JsonObject source=endpoint.execute(inventory(endpoint,UUID.randomUUID().toString(),0,""));
            assertEquals(source.toString(),"committed",status(source)); assertTrue(source.get("sourceComplete").getAsBoolean().value());
            Set<Quad> before=all(endpoint.data);
            endpoint.raw.begin(ReadWrite.READ);
            long version;
            try { version=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion(); }
            finally { endpoint.raw.end(); }
            JsonObject cancelled=endpoint.execute(envelope(endpoint.convert));
            assertTrue("the actual cancellation mutation must be reached: "+cancellationPredicate,endpoint.interrupted.get());
            assertEquals(cancelled.toString(),"deadline",status(cancelled)); assertEquals(before,all(endpoint.data));
            JsonObject row=source.get("rows").getAsArray().get(0).getAsObject();
            assertEquals("unresolved",status(endpoint.execute(disposition(endpoint,source,row)))); assertEquals(before,all(endpoint.data));
            endpoint.raw.begin(ReadWrite.READ);
            try {
                assertEquals(version,org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion());
                assertTrue(endpoint.raw.contains(CURRENT,id(1),RDF.type.asNode(),p("Claim")));
                assertFalse(endpoint.raw.contains(RECEIPTS,uri(receipt(endpoint.convert)),Node.ANY,Node.ANY));
            } finally { endpoint.raw.end(); }
        }
    }
    // ---- classification seal
    private record Classified(JsonObject source,JsonObject eof,List<JsonObject> pages,Map<String,JsonObject> rows) {}
    private static JsonObject sealRequest(Endpoint endpoint,JsonObject source,String proof,long deadline) {
        JsonObject input=JSON.parse(members(endpoint,source,"").get("claimFoldMembers").toString()); input.remove("progress"); input.put("proof",proof); input.put("deadline",deadline);
        JsonObject request=new JsonObject(); request.put("claimFoldClassifySeal",input); return request;
    }
    private static JsonObject sealRequest(Endpoint endpoint,JsonObject source,String proof) { return sealRequest(endpoint,source,proof,System.currentTimeMillis()+30_000); }
    private static JsonObject classifyToEof(Endpoint endpoint,JsonObject source,List<JsonObject> pages) throws Exception {
        String progress=""; JsonObject last;
        do { last=endpoint.execute(classify(endpoint,source,progress)); assertEquals(last.toString(),"classified",status(last)); pages.add(last); progress=last.get("progress").getAsString().value(); assertTrue(pages.size()<=200); } while(!progress.isEmpty());
        return last;
    }
    /** Real endpoint conversion of C1 plus retention of the cloned sources, then classification to the actual EOF. */
    private static Classified classifiedCorpus(Endpoint endpoint,int retained) throws Exception {
        addClassificationSources(endpoint,retained); RetainedSource captured=captureRetainedSource(endpoint); Map<String,JsonObject> original=sourceRows(endpoint,captured.source()); assertEquals(retained+1,original.size());
        assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
        for(int i=0;i<retained;i++) { JsonObject result=endpoint.execute(retain(endpoint,new RetainedSource(captured.source(),Objects.requireNonNull(original.get(id(500+i*2).getURI()))))); assertEquals(result.toString(),"retained",status(result)); }
        List<JsonObject> pages=new ArrayList<>(); JsonObject eof=classifyToEof(endpoint,captured.source(),pages);
        return new Classified(captured.source(),eof,pages,original);
    }
    private static String proof(JsonObject eof) { assertTrue(eof.toString(),eof.hasKey("classifiedProof")); return eof.get("classifiedProof").getAsString().value(); }
    private static JsonObject proofPayload(String proof) { return JSON.parse(new String(Base64.getUrlDecoder().decode(proof.split("\\.")[0]),StandardCharsets.UTF_8)); }
    private static String mint(JsonObject payload) {
        try { Method token=ClaimFoldInventory.class.getDeclaredMethod("classifiedToken",JsonObject.class); token.setAccessible(true); return (String)token.invoke(null,payload); }
        catch(ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    private static Node headerOf(Endpoint endpoint) { return uri(inventory(endpoint,UUID.randomUUID().toString(),0,"").get("claimFoldInventory").getAsObject().get("job").getAsObject().get("marker").getAsString().value()+":inventory"); }
    private static final Node STATE_GRAPH=uri(TemplateIndexService.STATE);
    private static JsonObject stored(DatasetGraph data,Node subject,Node predicate) { data.begin(ReadWrite.READ); try { return JSON.parse(one(data,STATE_GRAPH,subject,predicate).getLiteralLexicalForm()); } finally { data.end(); } }
    private static void sealBounds(JsonObject result,long[] actual) {
        JsonObject work=result.get("work").getAsObject();
        assertTrue("facade tuples: "+work,work.get("tuples").getAsNumber().value().intValue()<=ClaimFoldInventory.SEAL_TUPLES);
        assertTrue("facade probes: "+work,work.get("probes").getAsNumber().value().intValue()<=ClaimFoldInventory.SEAL_PROBES);
        assertTrue("facade bytes: "+work,work.get("bytes").getAsNumber().value().intValue()<=ClaimFoldInventory.SEAL_BYTES);
        assertTrue("all native index tuples (including private-state delete scans) exceeded the seal cap: "+Arrays.toString(actual),actual[0]<=ClaimFoldInventory.SEAL_TUPLES);
        assertTrue("all native index probes exceeded the seal cap: "+Arrays.toString(actual),actual[1]<=ClaimFoldInventory.SEAL_PROBES);
        assertTrue("all independently decoded bytes exceeded the seal cap: "+Arrays.toString(actual),actual[2]<=ClaimFoldInventory.SEAL_BYTES);
    }
    private static void assertQuietReplay(Endpoint endpoint,JsonObject request,JsonObject marker,Set<Quad> before,long version,long[] actual) throws Exception {
        Arrays.fill(actual,0); JsonObject replay=endpoint.execute(request);
        assertEquals(replay.toString(),"sealed",status(replay)); assertTrue(replay.get("replay").getAsBoolean().value()); assertEquals(marker.toString(),replay.get("marker").toString());
        assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); sealBounds(replay,actual);
    }
    private static void assertRefusedSeal(Endpoint endpoint,JsonObject request) throws Exception {
        Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject refused=endpoint.execute(request);
        assertEquals(refused.toString(),"unresolved",status(refused)); assertFalse(refused.hasKey("marker")); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
    }
    @Test public void sealRecordsTheActual129MixedClassifiedEofAndReplaysAsAHistoricalAckWithConstantWork() throws Exception {
        List<List<Long>> baseline=null;
        for(int growth:List.of(0,5000)) try(Endpoint endpoint=new Endpoint()) {
            classificationNoise(endpoint,growth); Classified corpus=classifiedCorpus(endpoint,128);
            for(JsonObject page:corpus.pages()) assertEquals("only the actual EOF page carries a proof",page==corpus.eof(),page.hasKey("classifiedProof"));
            assertEquals(129,corpus.eof().get("count").getAsNumber().value().intValue()); String proof=proof(corpus.eof());
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); Node header=headerOf(endpoint); long[] actual=classifierPhysical(endpoint.raw,()->{});
            JsonObject request=sealRequest(endpoint,corpus.source(),proof); Arrays.fill(actual,0); JsonObject sealed=endpoint.execute(request);
            assertEquals(sealed.toString(),"sealed",status(sealed)); assertFalse(sealed.get("replay").getAsBoolean().value()); sealBounds(sealed,actual); List<Long> cost=List.of(actual[0],actual[1],actual[2]);
            JsonObject marker=sealed.get("marker").getAsObject(); assertEquals(version,marker.get("snapshotVersion").getAsNumber().value().longValue()); assertEquals(version+1,marker.get("version").getAsNumber().value().longValue()); assertEquals(version+1,version(endpoint.raw));
            assertEquals(129,marker.get("count").getAsNumber().value().intValue()); assertEquals(1,marker.get("converted").getAsNumber().value().intValue()); assertEquals(128,marker.get("retained").getAsNumber().value().intValue());
            assertEquals(corpus.eof().get("transcript"),marker.get("transcript")); assertEquals(sha(proof),marker.get("requestDigest").getAsString().value()); assertEquals("urn:rezics:claim-fold-classified:"+sha(proof),marker.get("receipt").getAsString().value());
            Set<Quad> after=all(endpoint.data),added=new HashSet<>(after),removed=new HashSet<>(before); added.removeAll(before); removed.removeAll(after);
            assertEquals("only the marker and the terminal checkpoint link are added",2,added.size()); assertEquals("only the previous checkpoint link is replaced",1,removed.size());
            assertEquals(uri(header.getURI()+":conversions"),removed.iterator().next().getSubject()); assertEquals(p("claimFoldConversionCheckpoint"),removed.iterator().next().getPredicate());
            assertTrue(added.contains(new Quad(STATE_GRAPH,uri(header.getURI()+":classified"),p("claimFoldClassification"),NodeFactory.createLiteralString(JSON.toStringFlat(marker)))));
            JsonObject link=stored(endpoint.raw,uri(header.getURI()+":conversions"),p("claimFoldConversionCheckpoint")); assertEquals("",link.get("claim").getAsString().value()); assertEquals(marker.get("receipt"),link.get("receipt")); assertEquals(marker.get("version"),link.get("version"));
            // lost acknowledgement: exact replay of the stored request commits nothing
            assertQuietReplay(endpoint,sealRequest(endpoint,corpus.source(),proof),marker,after,version+1,actual); System.out.println("claim classification seal replay allIndexTuples/probes/decodedBytes="+List.of(actual[0],actual[1],actual[2]));
            // a later authenticated EOF binds a new snapshot and cannot replace the immutable marker
            List<JsonObject> pages=new ArrayList<>(); JsonObject again=classifyToEof(endpoint,corpus.source(),pages); assertEquals(corpus.eof().get("transcript"),again.get("transcript")); assertEquals(version+1,again.get("snapshotVersion").getAsNumber().value().longValue());
            assertNotEquals(proof,proof(again)); assertRefusedSeal(endpoint,sealRequest(endpoint,corpus.source(),proof(again)));
            // new dispositions refuse; exact historical replays keep their receipts
            JsonObject newRetention=endpoint.execute(retain(endpoint,new RetainedSource(corpus.source(),corpus.rows().get(id(1).getURI())))); assertEquals(newRetention.toString(),"unresolved",status(newRetention)); assertEquals(after,all(endpoint.data));
            JsonObject oldRetention=endpoint.execute(retain(endpoint,new RetainedSource(corpus.source(),corpus.rows().get(id(500).getURI())))); assertEquals(oldRetention.toString(),"retained",status(oldRetention)); assertEquals(after,all(endpoint.data));
            JsonObject oldConversion=endpoint.execute(envelope(endpoint.convert)); System.out.println("claim classification seal post-marker conversion replay status="+status(oldConversion)); assertEquals(after,all(endpoint.data)); assertEquals(version+1,version(endpoint.raw));
            // a foreign commit leaves history replayable but removes every fresh native authority
            endpoint.data.begin(ReadWrite.WRITE); try { endpoint.data.add(CONTROL,uri("urn:classifier:foreign"),p("heartbeat"),NodeFactory.createLiteralString("freshness changed")); endpoint.data.commit(); } finally { endpoint.data.end(); }
            Set<Quad> stale=all(endpoint.data); long staleVersion=version(endpoint.raw); assertQuietReplay(endpoint,sealRequest(endpoint,corpus.source(),proof),marker,stale,staleVersion,actual);
            unresolvedClassify(endpoint.execute(classify(endpoint,corpus.source(),""))); assertEquals(stale,all(endpoint.data));
            if(baseline==null) baseline=List.of(cost); else assertEquals("same-job acknowledgments and unrelated default growth changed seal work",baseline,List.of(cost));
            System.out.println("claim classification seal members=129 unrelated="+growth+" allIndexTuples/probes/decodedBytes="+cost+" facade="+sealed.get("work"));
        }
    }
    private static void assertForgedProofs(Endpoint endpoint,Classified corpus) throws Exception {
        String proof=proof(corpus.eof()); JsonObject good=proofPayload(proof); long count=good.get("count").getAsNumber().value().longValue();
        Map<String,java.util.function.Consumer<JsonObject>> defects=new LinkedHashMap<>();
        defects.put("count",x->x.put("count",count-1)); defects.put("count-extra",x->x.put("count",count+1));
        defects.put("converted",x->x.put("converted",good.get("converted").getAsNumber().value().longValue()+1)); defects.put("retained",x->x.put("retained",good.get("retained").getAsNumber().value().longValue()-1));
        defects.put("negative-partition",x->{ x.put("converted",-1L); x.put("retained",count+1); });
        defects.put("snapshot-before",x->x.put("snapshotVersion",good.get("snapshotVersion").getAsNumber().value().longValue()-1)); defects.put("snapshot-after",x->x.put("snapshotVersion",good.get("snapshotVersion").getAsNumber().value().longValue()+1));
        defects.put("construction",x->x.put("construction","0".repeat(64))); defects.put("sourceCut",x->x.put("sourceCut","1".repeat(64))); defects.put("seal",x->x.put("seal","2".repeat(64)));
        defects.put("attempt",x->x.put("attempt",UUID.randomUUID().toString())); defects.put("storage",x->x.put("storage","another-process:storage")); defects.put("job",x->x.put("job","urn:rezics:maintenance:other"));
        defects.put("wrong-purpose",x->x.put("purpose","claim-fold-classify-v1")); defects.put("extra-field",x->x.put("verdict","complete")); defects.put("missing-field",x->x.remove("transcript")); defects.put("bad-transcript",x->x.put("transcript","not-a-hash"));
        for(var defect:defects.entrySet()) {
            JsonObject payload=JSON.parse(good.toString()); defect.getValue().accept(payload); JsonObject refused=endpoint.execute(sealRequest(endpoint,corpus.source(),mint(payload)));
            assertEquals(defect.getKey()+": "+refused,"unresolved",status(refused)); assertFalse(refused.hasKey("marker"));
        }
        String[] parts=proof.split("\\."); String flippedMac=parts[0]+"."+(parts[1].charAt(0)=='0'?"1":"0")+parts[1].substring(1);
        String payload=parts[0]; String tampered=payload.substring(0,payload.length()/2)+(payload.charAt(payload.length()/2)=='A'?"B":"A")+payload.substring(payload.length()/2+1)+"."+parts[1];
        String wrongPurpose=null; for(JsonObject page:corpus.pages()) if(!page.get("progress").getAsString().value().isEmpty()) wrongPurpose=page.get("progress").getAsString().value();
        assertNotNull("classification cursor is the wrong purpose",wrongPurpose);
        for(String bad:List.of(flippedMac,tampered,wrongPurpose)) assertRefusedSeal(endpoint,sealRequest(endpoint,corpus.source(),bad));
    }
    @Test public void sealRefusesForgedWrongPurposeTamperedStaleForeignAndWrongIncarnationProofsWithoutWrites() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); assertEquals(3,corpus.eof().get("count").getAsNumber().value().intValue()); assertTrue("fixture must page before EOF",corpus.pages().size()>1);
            for(JsonObject page:corpus.pages().subList(0,corpus.pages().size()-1)) assertFalse("pre-EOF pages never carry a seal proof",page.hasKey("classifiedProof"));
            assertForgedProofs(endpoint,corpus);
            String proof=proof(corpus.eof()); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            try(Endpoint copied=new Endpoint(false,0,before)) { assertRefusedSeal(copied,sealRequest(copied,corpus.source(),proof)); }
            endpoint.data.begin(ReadWrite.WRITE); try { endpoint.data.add(CONTROL,uri("urn:classifier:foreign"),p("heartbeat"),NodeFactory.createLiteralString("freshness changed")); endpoint.data.commit(); } finally { endpoint.data.end(); }
            assertRefusedSeal(endpoint,sealRequest(endpoint,corpus.source(),proof)); assertNotEquals(version,version(endpoint.raw));
        }
        // a job with an unresolved member can never obtain a proof, so a pre-EOF seal has no authority to present
        try(Endpoint endpoint=new Endpoint()) {
            addClassificationSources(endpoint,2); RetainedSource captured=captureRetainedSource(endpoint); Map<String,JsonObject> original=sourceRows(endpoint,captured.source()); assertEquals("committed",status(endpoint.execute(envelope(endpoint.convert))));
            JsonObject row=original.get(id(500).getURI()); assertEquals("retained",status(endpoint.execute(retain(endpoint,new RetainedSource(captured.source(),row)))));
            List<JsonObject> pages=new ArrayList<>(); String progress=""; JsonObject last;
            do { last=endpoint.execute(classify(endpoint,captured.source(),progress)); if(!status(last).equals("classified")) break; pages.add(last); progress=last.get("progress").getAsString().value(); } while(!progress.isEmpty());
            unresolvedClassify(last); for(JsonObject page:pages) assertFalse(page.hasKey("classifiedProof"));
            if(!pages.isEmpty()) assertRefusedSeal(endpoint,sealRequest(endpoint,captured.source(),pages.getFirst().get("progress").getAsString().value()));
        }
    }
    /** Raw coherent rewrite of the stored marker and terminal link at the next physical version; nothing here can mint an authenticated token. */
    private static void rewriteSealed(Endpoint endpoint,java.util.function.BiConsumer<JsonObject,JsonObject> edit) {
        Node header=headerOf(endpoint),markerId=uri(header.getURI()+":classified"),linkId=uri(header.getURI()+":conversions");
        endpoint.data.begin(ReadWrite.WRITE);
        try {
            long next=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion()+1;
            JsonObject marker=JSON.parse(one(endpoint.data,STATE_GRAPH,markerId,p("claimFoldClassification")).getLiteralLexicalForm()),link=JSON.parse(one(endpoint.data,STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint")).getLiteralLexicalForm());
            // keep the independent exact snapshot+1 and link versions coherent with the new commit
            marker.put("snapshotVersion",next-1); marker.put("version",next); link.put("version",next); edit.accept(marker,link);
            endpoint.data.deleteAny(STATE_GRAPH,markerId,p("claimFoldClassification"),Node.ANY); endpoint.data.add(STATE_GRAPH,markerId,p("claimFoldClassification"),NodeFactory.createLiteralString(JSON.toStringFlat(marker)));
            endpoint.data.deleteAny(STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint"),Node.ANY); endpoint.data.add(STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint"),NodeFactory.createLiteralString(JSON.toStringFlat(link))); endpoint.data.commit();
        } finally { endpoint.data.end(); }
    }
    private static void retoken(JsonObject marker,JsonObject link,String proof) {
        marker.put("proof",proof); marker.put("requestDigest",sha(proof)); marker.put("receipt","urn:rezics:claim-fold-classified:"+sha(proof)); link.put("receipt","urn:rezics:claim-fold-classified:"+sha(proof));
    }
    @Test public void sealPersistsAtomicallyAndRefusesEveryCoherentRestampOfTheOriginalEofOnFreshAndHistoricalPaths() throws Exception {
        for(String defect:List.of("coherent-version","count","partition","partition-swap","extra-key","digest","claim","receipt","construction","transcript","proof-substituted","proof-mac","proof-missing","forged-consistent-token")) try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof()); JsonObject sealed=endpoint.execute(sealRequest(endpoint,corpus.source(),proof)); assertEquals(sealed.toString(),"sealed",status(sealed));
            JsonObject original=proofPayload(proof); long count=original.get("count").getAsNumber().value().longValue(),converted=original.get("converted").getAsNumber().value().longValue(),retained=original.get("retained").getAsNumber().value().longValue();
            rewriteSealed(endpoint,(marker,link)->{
                if(defect.equals("count")) marker.put("count",count+1);
                if(defect.equals("partition")) { marker.put("converted",-1L); marker.put("retained",count+1); }
                if(defect.equals("partition-swap")) { marker.put("converted",retained); marker.put("retained",converted); }
                if(defect.equals("extra-key")) marker.put("verified",true);
                if(defect.equals("digest")) marker.put("requestDigest","3".repeat(64));
                if(defect.equals("claim")) link.put("claim",id(1).getURI());
                if(defect.equals("receipt")) link.put("receipt","urn:rezics:claim-fold-classified:"+"4".repeat(64));
                if(defect.equals("construction")) marker.put("construction","5".repeat(64));
                if(defect.equals("transcript")) marker.put("transcript","6".repeat(64));
                if(defect.equals("proof-substituted")) { JsonObject other=JSON.parse(original.toString()); other.put("transcript","7".repeat(64)); retoken(marker,link,mint(other)); }
                if(defect.equals("proof-mac")) { String[] parts=proof.split("\\."); retoken(marker,link,parts[0]+"."+(parts[1].startsWith("0")?"1":"0")+parts[1].substring(1)); }
                if(defect.equals("proof-missing")) marker.remove("proof");
                // every field and version agrees with an invented token; only this process's MAC can tell it was never an actual EOF
                if(defect.equals("forged-consistent-token")) { JsonObject other=JSON.parse(original.toString()); other.put("snapshotVersion",marker.get("snapshotVersion").getAsNumber().value().longValue());
                    retoken(marker,link,Base64.getUrlEncoder().withoutPadding().encodeToString(JSON.toStringFlat(other).getBytes(StandardCharsets.UTF_8))+"."+"0".repeat(64)); }
            });
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            unresolvedClassify(endpoint.execute(classify(endpoint,corpus.source(),"")));
            JsonObject replay=endpoint.execute(sealRequest(endpoint,corpus.source(),proof)); assertEquals(defect+": the historical ack must compare every original field: "+replay,"unresolved",status(replay)); assertFalse(replay.hasKey("marker"));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    @Test public void classifyEofMustEqualAnInternallyAuthenticMarkerBeforeAnyProofOrEof() throws Exception {
        for(String field:List.of("construction","transcript","partition")) try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof()); assertEquals("sealed",status(endpoint.execute(sealRequest(endpoint,corpus.source(),proof))));
            // a process-authentic token that disagrees with the actual directory: only the EOF comparison can notice
            JsonObject other=proofPayload(proof); if(field.equals("partition")) { other.put("converted",other.get("converted").getAsNumber().value().longValue()+1); other.put("retained",other.get("retained").getAsNumber().value().longValue()-1); } else other.put(field,"8".repeat(64));
            rewriteSealed(endpoint,(marker,link)->{ JsonObject payload=JSON.parse(other.toString()); payload.put("snapshotVersion",marker.get("snapshotVersion").getAsNumber().value().longValue()); String token=mint(payload); marker.put("construction",payload.get("construction").getAsString().value()); marker.put("transcript",payload.get("transcript").getAsString().value());
                marker.put("converted",payload.get("converted").getAsNumber().value().longValue()); marker.put("retained",payload.get("retained").getAsNumber().value().longValue()); retoken(marker,link,token); });
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject members=endpoint.execute(members(endpoint,corpus.source(),"")); assertEquals("the stored record is internally authentic: "+members,"read",status(members));
            List<JsonObject> seen=new ArrayList<>(); String progress=""; JsonObject last;
            do { last=endpoint.execute(classify(endpoint,corpus.source(),progress)); if(!status(last).equals("classified")) break; seen.add(last); progress=last.get("progress").getAsString().value(); } while(!progress.isEmpty());
            assertEquals(field+": "+last,"unresolved",status(last)); assertTrue(last.toString(),last.get("error").getAsString().value().contains("stored marker")); assertFalse(last.hasKey("classificationEOF")); assertFalse(last.hasKey("classifiedProof"));
            for(JsonObject page:seen) assertFalse(page.hasKey("classifiedProof"));
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    @Test public void sealRequiresMaintenanceAuthBeforeParsingAndAClosedBoundedEnvelope() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); JsonObject valid=sealRequest(endpoint,corpus.source(),proof(corpus.eof())); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject malformed=new JsonObject(); malformed.put("claimFoldClassifySeal",false);
            for(String token:Arrays.asList(null,"2".repeat(64))) assertEquals(403,endpoint.post(malformed,token).statusCode());
            for(String token:Arrays.asList(null,"2".repeat(64))) assertEquals(403,endpoint.post(valid,token).statusCode());
            List<JsonObject> rejected=new ArrayList<>(); rejected.add(malformed);
            for(String field:List.of("count","version","marker","verdict","classificationEOF","converted","retained","complete","release")) { JsonObject bad=JSON.parse(valid.toString()); bad.get("claimFoldClassifySeal").getAsObject().put(field,"caller supplied"); rejected.add(bad); }
            JsonObject missing=JSON.parse(valid.toString()); missing.get("claimFoldClassifySeal").getAsObject().remove("proof"); rejected.add(missing);
            JsonObject mixed=JSON.parse(valid.toString()); mixed.put("claimFoldClassify",new JsonObject()); rejected.add(mixed);
            JsonObject mixedRetain=JSON.parse(valid.toString()); mixedRetain.put("claimFoldRetain",new JsonObject()); rejected.add(mixedRetain);
            JsonObject jobUnknown=JSON.parse(valid.toString()); jobUnknown.get("claimFoldClassifySeal").getAsObject().get("job").getAsObject().put("trusted",true); rejected.add(jobUnknown);
            JsonObject oversized=JSON.parse(valid.toString()); oversized.get("claimFoldClassifySeal").getAsObject().put("proof","x".repeat(16*1024)); rejected.add(oversized);
            JsonObject longProof=JSON.parse(valid.toString()); longProof.get("claimFoldClassifySeal").getAsObject().put("proof","a".repeat(5000)+"."+"b".repeat(64)); rejected.add(longProof);
            JsonObject badProof=JSON.parse(valid.toString()); badProof.get("claimFoldClassifySeal").getAsObject().put("proof","not a proof"); rejected.add(badProof);
            JsonObject badCut=JSON.parse(valid.toString()); badCut.get("claimFoldClassifySeal").getAsObject().put("sourceCut","short"); rejected.add(badCut);
            for(JsonObject bad:rejected) { var response=endpoint.post(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); }
            String raw=JSON.toStringFlat(valid);
            for(String bad:List.of(raw+" {}",raw.replaceFirst("\"deadline\"\\s*:","\"deadline\":1,\"deadline\":"))) { assertNotEquals(raw,bad); var response=endpoint.postRaw(bad,"1".repeat(64)); assertEquals(response.body(),400,response.statusCode()); }
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            assertEquals("sealed",status(endpoint.execute(valid)));
        }
    }
    @Test public void sealRefusesEmptyOriginalInventoriesWithoutChangingTheClassifierEmptyBehavior() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            assertEquals("committed",status(endpoint.execute(envelope(endpoint.acquire))));
            endpoint.data.begin(ReadWrite.WRITE); try { endpoint.data.deleteAny(CURRENT,id(1),RDF.type.asNode(),p("Claim")); endpoint.data.commit(); } finally { endpoint.data.end(); }
            String attempt=UUID.randomUUID().toString(),previous=""; JsonObject source; int ordinal=0;
            do { source=endpoint.execute(inventory(endpoint,attempt,ordinal++,previous)); assertEquals(source.toString(),"committed",status(source)); previous=source.get("hash").getAsString().value(); assertTrue(ordinal<=5); } while(!source.get("sourceComplete").getAsBoolean().value());
            assertEquals(0,source.get("total").getAsNumber().value().intValue());
            JsonObject empty=endpoint.execute(classify(endpoint,source,"")); assertEquals(empty.toString(),"classified",status(empty)); assertTrue(empty.get("classificationEOF").getAsBoolean().value()); assertEquals(0,empty.get("count").getAsNumber().value().intValue()); assertFalse("an empty inventory has no seal proof",empty.hasKey("classifiedProof"));
            Node header=headerOf(endpoint); JsonObject state=stored(endpoint.raw,header,p("inventoryCheckpoint")); JsonObject directory=stored(endpoint.raw,uri(header.getURI()+":members:seal:"+state.get("attempt").getAsString().value()),p("claimFoldDirectorySeal"));
            JsonObject payload=new JsonObject(); payload.put("purpose","claim-fold-classified-v1"); payload.put("job",header.getURI().substring(0,header.getURI().length()-":inventory".length())); payload.put("sourceCut",source.get("sourceCut").getAsString().value()); payload.put("seal",source.get("hash").getAsString().value());
            payload.put("attempt",state.get("attempt").getAsString().value()); payload.put("storage",empty.get("storage").getAsString().value()); payload.put("snapshotVersion",empty.get("snapshotVersion").getAsNumber().value().longValue()); payload.put("construction",directory.get("construction").getAsString().value());
            payload.put("count",0L); payload.put("converted",0L); payload.put("retained",0L); payload.put("transcript",empty.get("transcript").getAsString().value());
            assertRefusedSeal(endpoint,sealRequest(endpoint,source,mint(payload)));
        }
    }
    private static final class SteppingClock extends java.time.Clock {
        final java.util.concurrent.atomic.AtomicLong now=new java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis());
        @Override public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public java.time.Instant instant() { return java.time.Instant.ofEpochMilli(now.get()); }
        @Override public long millis() { return now.get(); }
    }
    @Test public void sealCancellationAndDeadlinesAbortTheMarkerAndTerminalLinkTogether() throws Exception {
        try(Endpoint endpoint=new Endpoint(p("claimFoldClassification"))) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof()); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            JsonObject cancelled=endpoint.execute(sealRequest(endpoint,corpus.source(),proof)); assertTrue("the actual marker mutation must be reached",endpoint.interrupted.get());
            assertEquals(cancelled.toString(),"deadline",status(cancelled)); assertFalse(cancelled.hasKey("marker")); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            assertClassified(endpoint.execute(classify(endpoint,corpus.source(),"")));
            JsonObject retried=endpoint.execute(sealRequest(endpoint,corpus.source(),proof)); assertEquals(retried.toString(),"sealed",status(retried)); assertFalse("cancelled attempt left no historical marker",retried.get("replay").getAsBoolean().value()); assertEquals(version+1,version(endpoint.raw));
        }
        // the absolute deadline expires right after each staged write, and before the final commit decision
        for(Node trigger:List.of(p("claimFoldClassification"),p("claimFoldConversionCheckpoint"))) try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof()); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); SteppingClock clock=new SteppingClock();
            DatasetGraph jumping=new DatasetGraphWrapper(endpoint.raw) {
                @Override public void add(Node graph,Node subject,Node predicate,Node object) { super.add(graph,subject,predicate,object); if(predicate.equals(trigger)) clock.now.addAndGet(120_000); }
            };
            byte[] body=JSON.toStringFlat(sealRequest(endpoint,corpus.source(),proof,clock.now.get()+30_000)).getBytes(StandardCharsets.UTF_8);
            JsonObject result=JSON.parse(ClaimFoldInventory.sealClassification(jumping,ClaimFoldInventory.parseClassifySeal(body),new java.util.concurrent.atomic.AtomicLong(),clock).toString());
            assertEquals(trigger+": "+result,"deadline",status(result)); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
            assertEquals("sealed",status(endpoint.execute(sealRequest(endpoint,corpus.source(),proof))));
        }
    }
    private static void assertClassified(JsonObject result) { assertEquals(result.toString(),"classified",status(result)); }
    @Test public void sealDeadlineIncludesWaitingForTheWriterAndLeavesNoMarker() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof()); Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw);
            byte[] body=JSON.toStringFlat(sealRequest(endpoint,corpus.source(),proof,System.currentTimeMillis()+1_000)).getBytes(StandardCharsets.UTF_8);
            var executor=java.util.concurrent.Executors.newSingleThreadExecutor(); java.util.concurrent.Future<String> future;
            try {
                synchronized(endpoint.data) {
                    future=executor.submit(()->ClaimFoldInventory.sealClassification(endpoint.data,ClaimFoldInventory.parseClassifySeal(body),new java.util.concurrent.atomic.AtomicLong()).toString());
                    Thread.sleep(2_500);
                }
                JsonObject result=JSON.parse(future.get(30,java.util.concurrent.TimeUnit.SECONDS)); assertEquals(result.toString(),"deadline",status(result));
            } finally { executor.shutdownNow(); }
            assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw)); assertEquals("sealed",status(endpoint.execute(sealRequest(endpoint,corpus.source(),proof))));
        }
    }
    @Test public void sealRefusesWhenTheStoredCutPassesTheWorkBudget() throws Exception {
        try(Endpoint endpoint=new Endpoint()) {
            Classified corpus=classifiedCorpus(endpoint,2); String proof=proof(corpus.eof());
            endpoint.data.begin(ReadWrite.WRITE);
            try {
                // An oversized stored scalar in the held product record is reached by the cold cut check; keep the independent version link coherent.
                Node header=headerOf(endpoint),linkId=uri(header.getURI()+":conversions"); long next=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(endpoint.raw).getTxnSystem().getThreadTransaction().getDataVersion()+1;
                endpoint.data.add(CONTROL,PRODUCT,p("oversizedWitness"),NodeFactory.createLiteralString("a".repeat(300_000)));
                JsonObject link=JSON.parse(one(endpoint.data,STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint")).getLiteralLexicalForm()); link.put("version",next);
                endpoint.data.deleteAny(STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint"),Node.ANY); endpoint.data.add(STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint"),NodeFactory.createLiteralString(JSON.toStringFlat(link))); endpoint.data.commit();
            } finally { endpoint.data.end(); }
            Set<Quad> before=all(endpoint.data); long version=version(endpoint.raw); JsonObject refused=endpoint.execute(sealRequest(endpoint,corpus.source(),proof));
            assertEquals(refused.toString(),"budget",status(refused)); assertFalse(refused.hasKey("marker")); assertEquals(before,all(endpoint.data)); assertEquals(version,version(endpoint.raw));
        }
    }
    private static String digest(Set<Quad> quads) {
        List<String> lines=new ArrayList<>(); for(Quad quad:quads) lines.add(NodeFmtLib.strNT(quad.getGraph())+" "+NodeFmtLib.strNT(quad.getSubject())+" "+NodeFmtLib.strNT(quad.getPredicate())+" "+NodeFmtLib.strNT(quad.getObject()));
        Collections.sort(lines); return sha(String.join("\n",lines));
    }
    /** A genuinely separate JVM: it reopens the persisted TDB2 files, so the process-random incarnation and MAC key are new. */
    public static final class Probe {
        public static void main(String[] args) throws Exception {
            DatasetGraph data=org.apache.jena.tdb2.TDB2Factory.connectDataset(args[0]).asDatasetGraph();
            for(String line:java.nio.file.Files.readAllLines(Path.of(args[1]))) {
                int tab=line.indexOf('\t'); String op=line.substring(0,tab); byte[] body=line.substring(tab+1).getBytes(StandardCharsets.UTF_8); JsonObject result;
                switch(op) {
                    case "digest" -> { result=new JsonObject(); result.put("digest",digest(all(data))); }
                    case "classify" -> result=ClaimFoldInventory.classify(data,ClaimFoldInventory.parseClassify(body));
                    case "members" -> result=ClaimFoldInventory.readMembers(data,ClaimFoldInventory.parseMembers(body));
                    case "seal" -> result=ClaimFoldInventory.sealClassification(data,ClaimFoldInventory.parseClassifySeal(body),new java.util.concurrent.atomic.AtomicLong());
                    case "rebind" -> result=rebind(data,JSON.parse(new String(body,StandardCharsets.UTF_8)).get("claimFoldMembers").getAsObject().get("job").getAsObject().get("marker").getAsString().value());
                    default -> throw new IllegalArgumentException(op);
                }
                System.out.println("RESULT "+JSON.toStringFlat(result));
            }
            System.exit(0);
        }
    }
    /** The most favourable raw rewrite for an attacker: rebind the checkpoint, marker and link to THIS process's incarnation and coherent versions. */
    private static JsonObject rebind(DatasetGraph data,String jobMarker) throws Exception {
        Method incarnation=ClaimFoldInventory.class.getDeclaredMethod("incarnation",DatasetGraph.class); incarnation.setAccessible(true); String now=(String)incarnation.invoke(null,data);
        Node header=uri(jobMarker+":inventory"),markerId=uri(header.getURI()+":classified"),linkId=uri(header.getURI()+":conversions");
        data.begin(ReadWrite.WRITE);
        try {
            long next=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(data).getTxnSystem().getThreadTransaction().getDataVersion()+1;
            JsonObject checkpoint=JSON.parse(one(data,STATE_GRAPH,header,p("inventoryCheckpoint")).getLiteralLexicalForm()),marker=JSON.parse(one(data,STATE_GRAPH,markerId,p("claimFoldClassification")).getLiteralLexicalForm()),link=JSON.parse(one(data,STATE_GRAPH,linkId,p("claimFoldConversionCheckpoint")).getLiteralLexicalForm());
            checkpoint.put("storage",now); marker.put("storage",now); link.put("storage",now); marker.put("snapshotVersion",next-1); marker.put("version",next); link.put("version",next);
            for(Object[] row:List.<Object[]>of(new Object[]{header,"inventoryCheckpoint",checkpoint},new Object[]{markerId,"claimFoldClassification",marker},new Object[]{linkId,"claimFoldConversionCheckpoint",link})) {
                data.deleteAny(STATE_GRAPH,(Node)row[0],p((String)row[1]),Node.ANY); data.add(STATE_GRAPH,(Node)row[0],p((String)row[1]),NodeFactory.createLiteralString(JSON.toStringFlat((JsonObject)row[2])));
            }
            data.commit();
        } finally { data.end(); }
        JsonObject result=new JsonObject(); result.put("status","rebound"); result.put("storage",now); return result;
    }
    private static List<JsonObject> restartedJvm(Path store,List<String> operations) throws Exception {
        Path script=store.resolveSibling(store.getFileName()+".ops"); java.nio.file.Files.write(script,operations);
        String classpath=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
        Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-Xmx256m","-cp",classpath,Probe.class.getName(),store.toAbsolutePath().toString(),script.toAbsolutePath().toString()).redirectErrorStream(true).start();
        String output=new String(child.getInputStream().readAllBytes(),StandardCharsets.UTF_8);
        assertTrue("child JVM exit: "+output,child.waitFor(120,java.util.concurrent.TimeUnit.SECONDS)); assertEquals(output,0,child.exitValue());
        List<JsonObject> results=new ArrayList<>(); for(String line:output.split("\n")) if(line.startsWith("RESULT ")) results.add(JSON.parse(line.substring(7)));
        assertEquals(output,operations.size(),results.size()); System.out.println("claim classification seal restarted JVM "+store.getFileName()+" statuses="+results.stream().map(r->r.hasKey("status")?r.get("status").getAsString().value():"digest").toList()); return results;
    }
    @Test public void aRealJvmRestartReplaysTheStoredMarkerAsHistoryButRefusesAllNewClassificationAndSealing() throws Exception {
        Path root=java.nio.file.Files.createDirectories(Path.of("target","claim-seal-restart-"+UUID.randomUUID())),sealedStore=root.resolve("sealed"),openStore=root.resolve("classified");
        String sealedBefore,openBefore; JsonObject sealedRequest,openRequest,sealedClassify,openClassify,sealedMembers,marker;
        try(Endpoint endpoint=new Endpoint(sealedStore)) {
            Classified corpus=classifiedCorpus(endpoint,2); sealedRequest=sealRequest(endpoint,corpus.source(),proof(corpus.eof()),System.currentTimeMillis()+300_000); JsonObject sealed=endpoint.execute(sealedRequest); assertEquals(sealed.toString(),"sealed",status(sealed));
            marker=sealed.get("marker").getAsObject(); sealedClassify=classify(endpoint,corpus.source(),""); sealedMembers=members(endpoint,corpus.source(),""); sealedBefore=digest(all(endpoint.data));
        }
        try(Endpoint endpoint=new Endpoint(openStore)) {
            Classified corpus=classifiedCorpus(endpoint,2); openRequest=sealRequest(endpoint,corpus.source(),proof(corpus.eof()),System.currentTimeMillis()+300_000); openClassify=classify(endpoint,corpus.source(),""); openBefore=digest(all(endpoint.data));
        }
        for(JsonObject request:List.of(sealedClassify,sealedMembers,openClassify)) request.get(request.keys().iterator().next()).getAsObject().put("deadline",System.currentTimeMillis()+300_000);
        String tampered=JSON.toStringFlat(sealedRequest); String mac=sealedRequest.get("claimFoldClassifySeal").getAsObject().get("proof").getAsString().value(); tampered=tampered.replace(mac,mac.substring(0,mac.length()-1)+(mac.endsWith("0")?"1":"0"));
        List<JsonObject> sealedResults=restartedJvm(sealedStore,List.of("digest\t","seal\t"+JSON.toStringFlat(sealedRequest),"classify\t"+JSON.toStringFlat(sealedClassify),"members\t"+JSON.toStringFlat(sealedMembers),"seal\t"+tampered,"digest\t"));
        assertEquals("the reopened JVM must see exactly the persisted state",sealedBefore,sealedResults.get(0).get("digest").getAsString().value());
        JsonObject replay=sealedResults.get(1); assertEquals(replay.toString(),"sealed",status(replay)); assertTrue("persisted lost-ack replay is historical",replay.get("replay").getAsBoolean().value()); assertEquals(marker.toString(),replay.get("marker").toString());
        unresolvedClassify(sealedResults.get(2)); assertNotEquals(sealedResults.get(3).toString(),"read",status(sealedResults.get(3))); assertFalse(sealedResults.get(3).hasKey("rows"));
        assertEquals(sealedResults.get(4).toString(),"unresolved",status(sealedResults.get(4))); assertEquals("restart operations must not write",sealedBefore,sealedResults.get(5).get("digest").getAsString().value());
        List<JsonObject> openResults=restartedJvm(openStore,List.of("digest\t","seal\t"+JSON.toStringFlat(openRequest),"classify\t"+JSON.toStringFlat(openClassify),"digest\t"));
        assertEquals(openBefore,openResults.get(0).get("digest").getAsString().value()); assertEquals(openResults.get(1).toString(),"unresolved",status(openResults.get(1))); assertFalse(openResults.get(1).hasKey("marker"));
        unresolvedClassify(openResults.get(2)); assertEquals("a new process must not seal or classify the old job",openBefore,openResults.get(3).get("digest").getAsString().value());
    }
    @Test public void aRealJvmRestartRefusesRestampedAndReboundMarkersWhileTheUnchangedOriginalAckStaysHistorical() throws Exception {
        Path root=java.nio.file.Files.createDirectories(Path.of("target","claim-seal-custody-"+UUID.randomUUID()));
        record Store(Path path,JsonObject seal,JsonObject classify,JsonObject members,JsonObject marker,String digest) {}
        List<Store> stores=new ArrayList<>();
        for(String variant:List.of("unchanged","restamped","rebound")) {
            Path path=root.resolve(variant);
            try(Endpoint endpoint=new Endpoint(path)) {
                Classified corpus=classifiedCorpus(endpoint,2); JsonObject request=sealRequest(endpoint,corpus.source(),proof(corpus.eof()),System.currentTimeMillis()+300_000); JsonObject sealed=endpoint.execute(request); assertEquals(sealed.toString(),"sealed",status(sealed));
                if(variant.equals("restamped")) rewriteSealed(endpoint,(marker,link)->{ marker.put("transcript","6".repeat(64)); });
                JsonObject classify=classify(endpoint,corpus.source(),""),members=members(endpoint,corpus.source(),"");
                for(JsonObject each:List.of(classify,members)) each.get(each.keys().iterator().next()).getAsObject().put("deadline",System.currentTimeMillis()+300_000);
                stores.add(new Store(path,request,classify,members,sealed.get("marker").getAsObject(),digest(all(endpoint.data))));
            }
        }
        Store unchanged=stores.get(0),restamped=stores.get(1),rebound=stores.get(2);
        List<JsonObject> kept=restartedJvm(unchanged.path(),List.of("seal\t"+JSON.toStringFlat(unchanged.seal()),"digest\t")); assertEquals(kept.get(0).toString(),"sealed",status(kept.get(0))); assertTrue(kept.get(0).get("replay").getAsBoolean().value()); assertEquals(unchanged.marker().toString(),kept.get(0).get("marker").toString()); assertEquals(unchanged.digest(),kept.get(1).get("digest").getAsString().value());
        List<JsonObject> stamped=restartedJvm(restamped.path(),List.of("seal\t"+JSON.toStringFlat(restamped.seal()),"classify\t"+JSON.toStringFlat(restamped.classify()),"digest\t"));
        assertEquals(stamped.get(0).toString(),"unresolved",status(stamped.get(0))); assertFalse(stamped.get(0).hasKey("marker")); unresolvedClassify(stamped.get(1)); assertEquals(restamped.digest(),stamped.get(2).get("digest").getAsString().value());
        List<JsonObject> moved=restartedJvm(rebound.path(),List.of("members\t"+JSON.toStringFlat(rebound.members()),"rebind\t"+JSON.toStringFlat(rebound.members()),"members\t"+JSON.toStringFlat(rebound.members()),"classify\t"+JSON.toStringFlat(rebound.classify()),"seal\t"+JSON.toStringFlat(rebound.seal())));
        assertNotEquals("a restarted process must see the old job as foreign: "+moved.get(0),"read",status(moved.get(0)));
        assertEquals(moved.get(1).toString(),"rebound",status(moved.get(1))); assertNotEquals("the favourable rebind must change the incarnation",rebound.marker().get("storage").getAsString().value(),moved.get(1).get("storage").getAsString().value());
        assertNotEquals("incarnation rebinding must not revive the old marker: "+moved.get(2),"read",status(moved.get(2))); assertFalse(moved.get(2).hasKey("rows")); unresolvedClassify(moved.get(3));
        assertEquals("the rebound original ack must not replay: "+moved.get(4),"unresolved",status(moved.get(4))); assertFalse(moved.get(4).hasKey("marker"));
    }
}
