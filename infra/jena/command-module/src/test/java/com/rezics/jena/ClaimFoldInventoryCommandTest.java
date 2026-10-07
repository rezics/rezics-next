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
        final FusekiServer server;
        Endpoint() { this(false); }
        Endpoint(boolean cancelCommit) { this(cancelCommit,0); }
        Endpoint(Node cancellationPredicate) { this(true,0,null,cancellationPredicate); }
        Endpoint(boolean cancelCommit,int growth) { this(cancelCommit,growth,null); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored) { this(cancelCommit,growth,restored,p("claimFoldDisposition")); }
        Endpoint(boolean cancelCommit,int growth,Set<Quad> restored,Node cancellationPredicate) {
            fixture=sourceFixture(growth); raw=(DatasetGraph)field(fixture,"data"); convert=conversion(fixture);
            if(restored!=null) {
                raw.begin(ReadWrite.WRITE);
                try { raw.deleteAny(Node.ANY,Node.ANY,Node.ANY,Node.ANY); restored.forEach(raw::add); raw.commit(); }
                finally { raw.end(); }
            }
            data=cancelCommit?new DatasetGraphWrapper(raw) {
                private void observe(Node graph,Node subject,Node predicate) {
                    boolean target=predicate.equals(cancellationPredicate)&&(cancellationPredicate.equals(p("claimFoldDisposition"))?graph.equals(uri(TemplateIndexService.STATE)):
                        graph.equals(RECEIPTS)&&subject.isURI()&&subject.getURI().startsWith(PREFIX+"convert:"));
                    if(target
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
            return HttpClient.newHttpClient().send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
        }
        JsonObject execute(JsonObject envelope) throws Exception { var response=post(envelope,"1".repeat(64)); assertEquals(response.body(),200,response.statusCode()); return JSON.parse(response.body()); }
        @Override public void close() { server.stop(); data.close(); }
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
        long[] reads={0,0,0,0,0,0};
        java.util.function.Consumer<Node[]> bytes=quad-> {
            Node graph=quad[0],predicate=quad[1],object=quad[2];
            long size=NodeFmtLib.strNT(predicate).getBytes(StandardCharsets.UTF_8).length+NodeFmtLib.strNT(object).getBytes(StandardCharsets.UTF_8).length;
            reads[2]+=size;
            if(graph.equals(uri(TemplateIndexService.STATE))) {
                if(predicate.equals(p("inventoryCheckpoint"))) { reads[3]+=size; reads[4]++; }
                if(predicate.equals(p("claimFoldConversionCheckpoint"))) { reads[3]+=size; reads[5]++; }
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
}
