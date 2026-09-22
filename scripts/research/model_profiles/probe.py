"""Bounded representation/SHACL/transaction counterexamples; not app qualification.

All ledgers, fixtures and logs use a fresh temporary directory. The optional
Fluree 4.2.1 server binds loopback only and is stopped in finally.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.metadata
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from owlrl import DeductiveClosure, OWLRL_Semantics
from pyshacl import validate
from rdflib import Graph, Namespace
from rdflib.namespace import OWL, RDF

PREFIX = """
@prefix ex: <https://example.org/profile-probe/> .
@prefix rz: <https://rezics.com/vocab/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix skosxl: <http://www.w3.org/2008/05/skos-xl#> .
@prefix schema: <https://schema.org/> .
@prefix oa: <http://www.w3.org/ns/oa#> .
"""

SHAPES = PREFIX + """
ex:MainShape a sh:NodeShape ; sh:targetClass rz:MainVersion ; sh:class rz:MainVersion ;
  sh:property [ sh:path rz:work ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .
ex:LabelShape a sh:NodeShape ; sh:targetClass skosxl:Label ;
  sh:property [ sh:path skosxl:literalForm ; sh:minCount 1 ; sh:maxCount 1 ;
                sh:or ( [ sh:datatype rdf:langString ] [ sh:datatype xsd:string ] ) ] .
ex:AnnotationShape a sh:NodeShape ; sh:targetSubjectsOf rz:classificationContext ;
  sh:class oa:Annotation ;
  sh:property [ sh:path oa:hasTarget ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;
  sh:property [ sh:path oa:hasBody ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .
ex:EntryShape a sh:NodeShape ; sh:targetClass schema:ListItem ;
  sh:property [ sh:path schema:item ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;
  sh:property [ sh:path rz:structure ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .
ex:JudgmentShape a sh:NodeShape ; sh:targetSubjectsOf rz:judgmentContext ;
  sh:property [ sh:path rz:fit ; sh:maxCount 1 ; sh:datatype xsd:integer ; sh:in (-1 1) ] ;
  sh:property [ sh:path rz:spoiler ; sh:maxCount 1 ; sh:datatype xsd:integer ; sh:in (0 1 2) ] .
ex:PreferredShape a sh:NodeShape ; sh:targetSubjectsOf skos:prefLabel ;
  sh:property [ sh:path skos:prefLabel ; sh:uniqueLang true ] .
ex:ParentShape a sh:NodeShape ; sh:targetClass ex:Parent ;
  sh:property [ sh:path ex:child ; sh:minCount 1 ; sh:node ex:ChildShape ] .
ex:ChildShape a sh:NodeShape ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] .
ex:DefaultShape a sh:NodeShape ; sh:targetClass ex:Defaulted ;
  sh:property [ sh:path ex:value ; sh:minCount 1 ; sh:defaultValue 7 ] .
ex:AnchorShape a sh:NodeShape ; sh:targetClass rz:RevisionAnchor ;
  sh:property [ sh:path rz:component ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .
ex:SlotShape a sh:NodeShape ; sh:targetClass ex:Slot ;
  sh:property [ sh:path ex:head ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;
  sh:property [ sh:path ex:version ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:integer ] .
"""

CASES = [
    ('standard-label-with-extension', 'ex:l a skosxl:Label ; skosxl:literalForm "Title"@en ; rz:role ex:Alias .', True),
    ('independent-same-language-labels', 'ex:a a skosxl:Label ; skosxl:literalForm "A"@en . ex:b a skosxl:Label ; skosxl:literalForm "B"@en .', True),
    ('one-label-two-forms', 'ex:a a skosxl:Label ; skosxl:literalForm "A"@en, "B"@en .', False),
    ('one-resource-two-preferred-same-language', 'ex:r skos:prefLabel "A"@en, "B"@en .', False),
    ('annotation-with-local-context', 'ex:a a oa:Annotation ; oa:hasTarget ex:t ; oa:hasBody ex:e ; rz:classificationContext ex:c .', True),
    ('annotation-missing-target', 'ex:a a oa:Annotation ; oa:hasBody ex:e ; rz:classificationContext ex:c .', False),
    ('two-occurrences-one-target', 'ex:a a schema:ListItem ; schema:item ex:t ; rz:structure ex:s . ex:b a schema:ListItem ; schema:item ex:t ; rz:structure ex:s .', True),
    ('multitype-open-resource', 'ex:a a schema:ListItem, ex:ChapterPlacement ; schema:item ex:t ; rz:structure ex:s ; ex:note "extra" .', True),
    ('zero-spoiler-absent-fit', 'ex:j rz:judgmentContext ex:c ; rz:spoiler 0 .', True),
    ('independent-fit-and-spoiler', 'ex:j rz:judgmentContext ex:c ; rz:fit -1 ; rz:spoiler 2 .', True),
    ('invalid-zero-fit', 'ex:j rz:judgmentContext ex:c ; rz:fit 0 .', False),
    ('invalid-spoiler-three', 'ex:j rz:judgmentContext ex:c ; rz:spoiler 3 .', False),
    ('main-missing-work', 'ex:m a rz:MainVersion .', False),
    ('main-two-work-refs', 'ex:m a rz:MainVersion ; rz:work ex:a, ex:b .', False),
    ('default-does-not-satisfy-required-field', 'ex:d a ex:Defaulted .', False),
    ('referenced-child-valid', 'ex:p a ex:Parent ; ex:child ex:c . ex:c ex:name "C" .', True),
    ('referenced-child-missing-name', 'ex:p a ex:Parent ; ex:child ex:c . ex:c ex:unrelated true .', False),
    ('anchor-before', 'ex:a a rz:RevisionAnchor ; rz:component ex:before .', True),
    ('anchor-after-different-meaning', 'ex:a a rz:RevisionAnchor ; rz:component ex:after .', True),
    ('removed-target-type-vacuous-pass', 'ex:m ex:note "main type removed" .', True),
    ('label-with-unasserted-language', 'ex:l a skosxl:Label ; skosxl:literalForm "Title" .', True),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fluree', type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix='rezics-model-profile-evidence-'))
    report = {'scope': 'bounded research, not production qualification',
              'python': sys.version.split()[0],
              'probe_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'versions': {p: importlib.metadata.version(p) for p in ('rdflib', 'pyshacl', 'owlrl')},
              'checks': [], 'observations': []}
    print('Evidence directory:', root, flush=True)

    def record(label, actual, expected):
        report['checks'].append({'check': label, 'actual': actual, 'expected': expected, 'passed': actual == expected})
        print(('PASS' if actual == expected else 'FAIL'), label, flush=True)
        if actual != expected:
            raise AssertionError((label, actual, expected))

    shape_file = root / 'shapes.ttl'
    shape_file.write_text(SHAPES)
    sg = Graph().parse(data=SHAPES, format='turtle')
    try:
        # Validate the shapes themselves once; individual data cases use explicit
        # expected outcomes rather than inferring success from process exit alone.
        validate(Graph(), shacl_graph=sg, meta_shacl=True, inference='none', advanced=False)
        for label, body, expected in CASES:
            data = PREFIX + body
            (root / (label + '.ttl')).write_text(data)
            conforms, rg, text = validate(Graph().parse(data=data, format='turtle'), shacl_graph=sg,
                                         inference='none', advanced=False, do_owl_imports=False)
            record('reference:' + label, bool(conforms), expected)
            (root / (label + '.report.txt')).write_text(text)

        closed = Graph().parse(data=SHAPES + '\nex:EntryShape sh:closed true ; sh:ignoredProperties (rdf:type) .', format='turtle')
        multi = Graph().parse(data=PREFIX + CASES[7][1], format='turtle')
        record('reference:closed-whole-resource-rejects-unrelated-property',
               bool(validate(multi, shacl_graph=closed, inference='none')[0]), False)

        ex = Namespace('https://example.org/profile-probe/')
        eq = Graph().parse(data=PREFIX + 'ex:p a owl:FunctionalProperty . ex:s ex:p ex:a, ex:b .', format='turtle')
        DeductiveClosure(OWLRL_Semantics).expand(eq)
        record('owl-functional-property-derives-identity-not-unique-key-rejection',
               (ex.a, OWL.sameAs, ex.b) in eq or (ex.b, OWL.sameAs, ex.a) in eq, True)

        if args.fluree:
            run_fluree(args.fluree.resolve(strict=True), root, sg, report, record)
    finally:
        report['artifact_sha256'] = hashlib.sha256(shape_file.read_bytes()).hexdigest()
        (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print('Result:', root / 'result.json', flush=True)


def run_fluree(binary, root, sg, report, record):
    version = subprocess.check_output([str(binary), '--version'], text=True, timeout=10).strip()
    if version != 'fluree 4.2.1':
        raise RuntimeError('This probe targets Fluree 4.2.1: ' + version)
    report['fluree'] = {'version': version, 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    for label, _, expected in CASES:
        p = subprocess.run([str(binary), '--no-color', 'validate', str(root / (label + '.ttl')),
                            '--shacl', str(root / 'shapes.ttl'), '--format', 'jsonld'],
                           cwd=root, capture_output=True, text=True, timeout=30)
        (root / (label + '.fluree.log')).write_text(p.stdout + p.stderr)
        # A nonzero exit alone could be a parser/runtime failure, not nonconformance.
        payload = json.loads(p.stdout)
        serialized = json.dumps(payload)
        conforms = payload.get('sh:conforms', payload.get('http://www.w3.org/ns/shacl#conforms'))
        if conforms is None:
            raise RuntimeError('Missing validation report: ' + serialized[:1000])
        record('fluree-file:' + label, conforms, expected)

    for command in [['init'], ['create', 'profile-probe'],
                    ['insert', '-e', json.dumps({'@graph': json.loads(sg.serialize(format='json-ld'))})]]:
        p = subprocess.run([str(binary), '--direct', '--no-color', *command], cwd=root,
                           capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError(p.stdout + p.stderr)

    ctx = {'ex': 'https://example.org/profile-probe/', 'rz': 'https://rezics.com/vocab/',
           'f': 'https://ns.flur.ee/db#'}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}/v1/fluree'

    def request(route, body, content_type='application/json'):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        req = urllib.request.Request(base + route, data=data,
                                     headers={'Content-Type': content_type})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def update(body):
        return request('/update/profile-probe', {'@context': ctx, **body})

    def forced_shape(operation, predicate, required_shape):
        return {'@context': {**ctx, 'sh': 'http://www.w3.org/ns/shacl#'}, '@graph': [{
            '@id': 'ex:Force_' + operation.split(':')[-1], '@type': 'sh:NodeShape',
            'sh:targetNode': {'@id': operation},
            'sh:property': {'sh:path': {'@id': predicate}, 'sh:minCount': 1,
                            'sh:node': {'@id': required_shape}}}]}

    def query(where, select):
        status, result = request('/query/profile-probe', {'@context': ctx, 'where': where, 'select': select})
        if status != 200:
            raise RuntimeError(result)
        return result

    def full_conformance():
        status, result = request('/validate/profile-probe', {})
        report['observations'].append({'full_validation_status': status, 'body': result})
        return result

    log = (root / 'server.log').open('w')
    server = subprocess.Popen([str(binary), '--no-color', 'server', 'run', '--listen-addr', f'127.0.0.1:{port}',
                               '--storage-path', str(root / '.fluree/storage'), '--log-level', 'warn'],
                              cwd=root, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError((root / 'server.log').read_text())
            try:
                query({'@id': '?s', '@type': 'ex:Slot'}, ['?s'])
                break
            except (OSError, RuntimeError):
                time.sleep(.1)
        else:
            raise RuntimeError('Fluree did not become ready')

        bad = update({'insert': {'@id': 'ex:bad', '@type': 'rz:MainVersion'}})
        record('fluree-transaction:required-field-rejected', bad[0] >= 400, True)

        # Shape conformance cannot distinguish a permitted anchor change from
        # a forbidden retarget: both individually valid states have the same form.
        record('fluree-transaction:anchor-create', update({'insert': {'@id': 'ex:anchor', '@type': 'rz:RevisionAnchor', 'rz:component': {'@id': 'ex:before'}}})[0], 200)
        moved = update({'delete': {'@id': 'ex:anchor', 'rz:component': {'@id': 'ex:before'}},
                        'insert': {'@id': 'ex:anchor', 'rz:component': {'@id': 'ex:after'}}})
        record('fluree-transaction:shape-alone-allows-anchor-retarget', moved[0], 200)

        record('fluree-transaction:main-create', update({'insert': {'@id': 'ex:main', '@type': 'rz:MainVersion', 'rz:work': {'@id': 'ex:work'}}})[0], 200)
        dropped = update({'delete': {'@id': 'ex:main', '@type': 'rz:MainVersion', 'rz:work': {'@id': 'ex:work'}},
                          'insert': {'@id': 'ex:main', 'ex:note': 'type removed'}})
        record('fluree-transaction:removing-target-type-evades-class-shape', dropped[0], 200)

        record('fluree-transaction:valid-reference-create', update({'insert': [
            {'@id': 'ex:parent', '@type': 'ex:Parent', 'ex:child': {'@id': 'ex:child'}},
            {'@id': 'ex:child', 'ex:name': 'Child'}]})[0], 200)
        child = update({'delete': {'@id': 'ex:child', 'ex:name': 'Child'},
                        'insert': {'@id': 'ex:child', 'ex:unrelated': True}})
        full_report = full_conformance()
        report['observations'].append({'reference_child_change': child, 'subsequent_full_report': full_report})
        record('fluree-transaction:child-edit-not-rejected-by-parent-shape', child[0], 200)
        record('fluree-full-validation:parent-is-invalid-after-child-edit', full_report.get('conforms'), False)
        # Restore before further cases even if this build rejected the change.
        record('fluree-transaction:restore-child', update({'insert': {'@id': 'ex:child', 'ex:name': 'Child'}})[0], 200)

        # A newly written operation node can force a nested validation of an
        # unchanged parent. The per-operation shape is transient; storing a
        # live-target shape on historical receipts would invalidate history.
        inline = forced_shape('ex:force-operation', 'ex:validateParent', 'ex:ParentShape')
        force = update({'delete': {'@id': 'ex:child', 'ex:name': 'Child'},
                        'insert': {'@id': 'ex:force-operation', 'ex:validateParent': {'@id': 'ex:parent'}},
                        'opts': {'shapes': inline}})
        report['observations'].append({'inline_force_parent': force})
        record('fluree-transaction:inline-focus-validates-unchanged-parent', force[0] >= 400, True)
        record('fluree-transaction:inline-failure-is-node-constraint', 'NodeConstraintComponent' in str(force[1]), True)
        record('fluree-transaction:rejected-inline-focus-has-no-receipt',
               query({'@id': 'ex:force-operation', 'ex:validateParent': '?p'}, ['?p']), [])

        valid_force = update({'delete': {'@id': 'ex:child', 'ex:name': 'Child'},
                              'insert': [{'@id': 'ex:child', 'ex:name': 'New name'},
                                         {'@id': 'ex:valid-operation', 'ex:validateParent': {'@id': 'ex:parent'}}],
                              'opts': {'shapes': forced_shape('ex:valid-operation', 'ex:validateParent', 'ex:ParentShape')}})
        record('fluree-transaction:valid-inline-focus-commits', valid_force[0], 200)
        record('fluree-transaction:valid-inline-focus-has-one-receipt',
               len(query({'@id': 'ex:valid-operation', 'ex:validateParent': '?p'}, ['?p'])), 1)
        later = update({'delete': {'@id': 'ex:child', 'ex:name': 'New name'},
                        'insert': {'@id': 'ex:child', 'ex:later': True}})
        record('fluree-transaction:old-receipt-does-not-retain-live-inline-shape', later[0], 200)
        update({'insert': {'@id': 'ex:child', 'ex:name': 'Child'}})

        update({'insert': {'@id': 'ex:main', '@type': 'rz:MainVersion', 'rz:work': {'@id': 'ex:work'}}})
        type_force = update({'delete': {'@id': 'ex:main', '@type': 'rz:MainVersion', 'rz:work': {'@id': 'ex:work'}},
                             'insert': {'@id': 'ex:type-operation', 'ex:validateMain': {'@id': 'ex:main'}},
                             'opts': {'shapes': forced_shape('ex:type-operation', 'ex:validateMain', 'ex:MainShape')}})
        report['observations'].append({'inline_force_removed_type': type_force})
        record('fluree-transaction:forced-shape-survives-target-type-removal',
               type_force[0] >= 400 and 'NodeConstraintComponent' in str(type_force[1]), True)
        only_type = update({'delete': {'@id': 'ex:main', '@type': 'rz:MainVersion'},
                            'insert': {'@id': 'ex:type-only-operation', 'ex:validateMain': {'@id': 'ex:main'}},
                            'opts': {'shapes': forced_shape('ex:type-only-operation', 'ex:validateMain', 'ex:MainShape')}})
        record('fluree-transaction:forced-profile-requires-semantic-type',
               only_type[0] >= 400 and 'NodeConstraintComponent' in str(only_type[1]), True)

        # Probe the out-of-box override, then explicitly pin the desired posture.
        soft = update({'insert': {'@id': 'ex:soft', '@type': 'rz:MainVersion'}, 'opts': {'validationMode': 'warn'}})
        report['observations'].append({'unconfigured_warn_override': soft})
        update({'delete': {'@id': 'ex:soft', '@type': 'rz:MainVersion'}})
        config = '''PREFIX f: <https://ns.flur.ee/db#>
        INSERT DATA { GRAPH <urn:fluree:profile-probe:main#config> {
          <urn:fluree:profile-probe:main:config:ledger> a f:LedgerConfig ;
            f:shaclDefaults <urn:profile-probe:shacl> .
          <urn:profile-probe:shacl> f:shaclEnabled true ;
            f:validationMode f:ValidationReject ; f:overrideControl f:OverrideNone .
        } }'''
        permissive = request('/update/profile-probe', config.replace('f:OverrideNone', 'f:OverrideAll'), 'application/sparql-update')
        record('fluree-transaction:explicit-override-all-config', permissive[0], 200)
        explicit_soft = update({'insert': {'@id': 'ex:explicit-soft', '@type': 'rz:MainVersion'}, 'opts': {'validationMode': 'warn'}})
        report['observations'].append({'explicit_override_all_warn_request': explicit_soft})
        record('fluree-transaction:explicit-override-all-allows-warn', explicit_soft[0], 200)
        update({'delete': {'@id': 'ex:explicit-soft', '@type': 'rz:MainVersion'}})
        pin = '''PREFIX f: <https://ns.flur.ee/db#>
        DELETE DATA { GRAPH <urn:fluree:profile-probe:main#config> {
          <urn:profile-probe:shacl> f:overrideControl f:OverrideAll .
        } };
        INSERT DATA { GRAPH <urn:fluree:profile-probe:main#config> {
          <urn:profile-probe:shacl> f:overrideControl f:OverrideNone .
        } }'''
        configured = request('/update/profile-probe', pin, 'application/sparql-update')
        report['observations'].append({'pin_reject_config': configured})
        record('fluree-transaction:pin-reject-config', configured[0], 200)
        pinned = update({'insert': {'@id': 'ex:pinned-bad', '@type': 'rz:MainVersion'}, 'opts': {'validationMode': 'warn'}})
        record('fluree-transaction:pinned-reject-resists-warn-request', pinned[0] >= 400, True)

        record('fluree-transaction:slot-create', update({'insert': {'@id': 'ex:slot', '@type': 'ex:Slot', 'ex:head': {'@id': 'ex:h0'}, 'ex:version': 0}})[0], 200)

        def contender(i):
            return update({'where': {'@id': 'ex:slot', 'ex:version': 0, 'ex:head': {'@id': 'ex:h0'}},
                           'delete': {'@id': 'ex:slot', 'ex:version': 0, 'ex:head': {'@id': 'ex:h0'}},
                           'insert': [{'@id': 'ex:slot', 'ex:version': 1, 'ex:head': {'@id': f'ex:h{i}'}},
                                      {'@id': f'ex:receipt{i}', 'ex:operation': f'candidate-{i}', 'ex:validateSlot': {'@id': 'ex:slot'}}],
                           'opts': {'shapes': forced_shape(f'ex:receipt{i}', 'ex:validateSlot', 'ex:SlotShape')}})

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(contender, range(1, 9)))
        report['observations'].append({'concurrent_responses': results})
        record('fluree-transaction:one-receipt-for-eight-same-head-contenders',
               len(query({'@id': '?r', 'ex:operation': '?op'}, ['?r', '?op'])), 1)
        record('fluree-transaction:slot-advances-once', query({'@id': 'ex:slot', 'ex:version': '?v'}, ['?v']), [[1]])
        record('fluree-full-validation:final-state-conforms', full_conformance().get('conforms'), True)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()


if __name__ == '__main__':
    main()
