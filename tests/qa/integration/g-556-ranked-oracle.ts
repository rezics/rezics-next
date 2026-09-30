import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerEnvironment, root, run } from '../../../scripts/fixture/stack.ts';

/** Read the live stack's committed Lucene files with an independent, unpaged
 * IndexSearcher. Jena's text:query property function groups hits in a hash map
 * and loses their rank order, so it cannot supply the traversal oracle. */
export function rankedLuceneOracle(target: string) {
  const docker = dockerEnvironment();
  const project = `rezics-qa-${target}`;
  const container = run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=fuseki'], docker).trim();
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('ranked fixture Fuseki container is missing');
  const jdk = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!jdk) throw new Error('pinned Jena module JDK is missing');
  const directory = join(root, '.temp/g556-ranked-oracle', target);
  mkdirSync(directory, { recursive: true });
  try {
    run('docker', ['cp', `${container}:/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar`,
      join(directory, 'fuseki-server.jar')], docker);
    writeFileSync(join(directory, 'RankOracle.java'), `
import java.nio.file.Path;
import org.apache.lucene.analysis.cjk.CJKAnalyzer;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.queryparser.classic.QueryParser;
import org.apache.lucene.search.*;
import org.apache.lucene.store.FSDirectory;
import org.apache.jena.atlas.json.*;
class RankOracle {
  public static void main(String[] args) throws Exception {
    try (var directory = FSDirectory.open(Path.of("/fuseki/databases/rezics/lucene"));
         var reader = DirectoryReader.open(directory); var analyzer = new CJKAnalyzer()) {
      var query = new BooleanQuery.Builder()
        .add(new QueryParser("body", analyzer).parse(args[0]), BooleanClause.Occur.MUST)
        .add(new TermQuery(new Term("graph", "urn:rezics:search:public")), BooleanClause.Occur.FILTER).build();
      var searcher = new IndexSearcher(reader);
      var hits = new JsonArray();
      for (var hit : searcher.search(query, 1000).scoreDocs) {
        var row = new JsonObject();
        row.put("id", searcher.storedFields().document(hit.doc, java.util.Set.of("uri")).get("uri"));
        row.put("score", Float.toString(hit.score)); hits.add(row);
      }
      var result = new JsonObject();
      result.put("commit", Long.toString(reader.getIndexCommit().getGeneration()));
      result.put("hits", hits); System.out.println("G556_ORACLE_RESULT=" + JSON.toStringFlat(result));
    }
  }
}
`);
    const output = run('docker', ['run', '--rm', '--network', 'none',
      '--volume', `${project}_fuseki_data:/fuseki/databases:ro`,
      '--volume', `${directory}:/oracle:ro`, '--entrypoint', 'java', jdk,
      '--class-path', '/oracle/fuseki-server.jar', '/oracle/RankOracle.java', '"fixture body"'], docker);
    const json = output.split('\n').find(line => line.startsWith('G556_ORACLE_RESULT='))?.slice(19);
    if (!json) throw new Error('independent Lucene oracle did not return results');
    return JSON.parse(json) as { commit: string; hits: Array<{ id: string; score: string }> };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
