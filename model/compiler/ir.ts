/** The authored subset of SHACL used by the first converted profiles. */
export type Term = `${string}:${string}` | `<${string}>` | `"${string}"` | `${number}`;

export interface PropertyDefinition {
  path: Term;
  minCount?: number;
  maxCount?: number;
  nodeKind?: Term;
  class?: Term;
  datatype?: Term;
  pattern?: string;
  in?: readonly Term[];
  languageIn?: readonly string[];
  uniqueLang?: boolean;
  minLength?: number;
  maxLength?: number;
  minInclusive?: number;
  maxInclusive?: number;
  hasValue?: Term;
  /** Some reviewed profiles place a fixed value before the cardinality facet. */
  hasValueBeforeMaxCount?: boolean;
  /** A long compact property may continue after this many clauses. */
  wrapAfter?: number;
  /** Source formatting only; entries count clauses including sh:path. */
  lineBreaks?: readonly { after: number; indent: number }[];
}

export interface ShapeDefinition {
  iri: string;
  properties: readonly PropertyDefinition[];
  /** SHACL disjunction of local property groups. */
  or?: readonly (readonly PropertyDefinition[])[];
}

export interface ProfileDefinition {
  id: string;
  comments: readonly string[];
  prefixes: readonly (readonly [name: string, iri: string])[];
  layout: 'expanded' | 'compact';
  shapes: readonly ShapeDefinition[];
}

function propertyClauses(property: PropertyDefinition): string[] {
  const clauses = [`sh:path ${property.path}`];
  if (property.minCount !== undefined) clauses.push(`sh:minCount ${property.minCount}`);
  if (property.hasValueBeforeMaxCount && property.hasValue !== undefined) clauses.push(`sh:hasValue ${property.hasValue}`);
  if (property.maxCount !== undefined) clauses.push(`sh:maxCount ${property.maxCount}`);
  if (property.nodeKind !== undefined) clauses.push(`sh:nodeKind ${property.nodeKind}`);
  if (property.class !== undefined) clauses.push(`sh:class ${property.class}`);
  if (property.datatype !== undefined) clauses.push(`sh:datatype ${property.datatype}`);
  if (property.pattern !== undefined) clauses.push(`sh:pattern ${JSON.stringify(property.pattern)}`);
  if (property.in !== undefined) clauses.push(`sh:in ( ${property.in.join(' ')} )`);
  if (property.languageIn !== undefined) clauses.push(`sh:languageIn ( ${property.languageIn.map(JSON.stringify).join(' ')} )`);
  if (property.uniqueLang !== undefined) clauses.push(`sh:uniqueLang ${property.uniqueLang}`);
  if (property.minLength !== undefined) clauses.push(`sh:minLength ${property.minLength}`);
  if (property.maxLength !== undefined) clauses.push(`sh:maxLength ${property.maxLength}`);
  if (property.minInclusive !== undefined) clauses.push(`sh:minInclusive ${property.minInclusive}`);
  if (property.maxInclusive !== undefined) clauses.push(`sh:maxInclusive ${property.maxInclusive}`);
  if (!property.hasValueBeforeMaxCount && property.hasValue !== undefined) clauses.push(`sh:hasValue ${property.hasValue}`);
  return clauses;
}

function renderProperty(property: PropertyDefinition, layout: ProfileDefinition['layout'], indent = 4): string {
  const clauses = propertyClauses(property);
  if (layout === 'expanded') {
    return `${' '.repeat(indent)}sh:property [\n${clauses.map(clause => `${' '.repeat(indent + 4)}${clause} ;\n`).join('')}${' '.repeat(indent)}]`;
  }
  const breaks = property.lineBreaks ?? (property.wrapAfter === undefined ? [] : [{ after: property.wrapAfter, indent: 8 }]);
  const breakMap = new Map(breaks.map(({ after, indent }) => [after, indent]));
  if (breakMap.size !== breaks.length || breaks.some(({ after, indent }) =>
    after < 1 || after >= clauses.length || !Number.isInteger(indent) || indent < 1)) {
    throw new Error(`Invalid line breaks on ${property.path}`);
  }
  let output = `${' '.repeat(indent)}sh:property [ `;
  for (let index = 0; index < clauses.length; index++) {
    output += clauses[index];
    if (index < clauses.length - 1) {
      output += ' ;';
      output += breakMap.has(index + 1) ? `\n${' '.repeat(breakMap.get(index + 1)!)}` : ' ';
    }
  }
  return `${output} ]`;
}

function renderOr(branches: readonly (readonly PropertyDefinition[])[]): string {
  if (branches.length < 2 || branches.some(branch => !branch.length)) {
    throw new Error('sh:or requires at least two nonempty property groups');
  }
  const lines = branches.map(branch => branch.map((property, index) => {
    const prefix = index === 0 ? '        [ ' : '          ';
    const suffix = index === branch.length - 1 ? ' ]' : ' ;';
    return `${prefix}${renderProperty(property, 'compact', 0)}${suffix}`;
  }).join('\n'));
  return `    sh:or (\n${lines.join('\n')}\n    )`;
}

function validateProperty(property: PropertyDefinition): void {
  if (property.minCount !== undefined && (!Number.isInteger(property.minCount) || property.minCount < 0)) {
    throw new Error(`Invalid minCount on ${property.path}`);
  }
  if (property.maxCount !== undefined && (!Number.isInteger(property.maxCount) || property.maxCount < 0)) {
    throw new Error(`Invalid maxCount on ${property.path}`);
  }
  if (property.minCount !== undefined && property.maxCount !== undefined && property.minCount > property.maxCount) {
    throw new Error(`minCount exceeds maxCount on ${property.path}`);
  }
  if (property.minLength !== undefined && property.maxLength !== undefined && property.minLength > property.maxLength) {
    throw new Error(`minLength exceeds maxLength on ${property.path}`);
  }
  if (property.minInclusive !== undefined && property.maxInclusive !== undefined && property.minInclusive > property.maxInclusive) {
    throw new Error(`minInclusive exceeds maxInclusive on ${property.path}`);
  }
  if (property.in !== undefined && !property.in.length) throw new Error(`Empty sh:in on ${property.path}`);
  if (property.languageIn !== undefined && !property.languageIn.length) {
    throw new Error(`Empty sh:languageIn on ${property.path}`);
  }
}

export function renderProfile(profile: ProfileDefinition): string {
  if (!/^[a-z0-9-]+-v\d+$/.test(profile.id)) throw new Error(`Invalid profile ID: ${profile.id}`);
  if (!profile.shapes.length || new Set(profile.shapes.map(shape => shape.iri)).size !== profile.shapes.length) {
    throw new Error(`${profile.id} must declare distinct named NodeShapes`);
  }
  const prefixNames = new Set(profile.prefixes.map(([name]) => name));
  if (!prefixNames.has('sh')) throw new Error(`${profile.id} must declare the sh prefix`);
  for (const shape of profile.shapes) {
    if (!shape.iri.startsWith(`https://rezics.com/definition/${profile.id}/`)) {
      throw new Error(`${profile.id} has a shape outside its definition namespace`);
    }
    if (!shape.properties.length) throw new Error(`${shape.iri} must have properties`);
    if (shape.or && profile.layout !== 'compact') throw new Error(`${shape.iri} requires compact layout for sh:or`);
    for (const property of shape.properties) validateProperty(property);
    for (const branch of shape.or ?? []) for (const property of branch) validateProperty(property);
  }
  const header = `${profile.comments.map(comment => `# ${comment}\n`).join('')}${profile.prefixes.map(([name, iri]) => `@prefix ${name}: <${iri}> .\n`).join('')}\n`;
  const shapes = profile.shapes.map(shape => {
    const properties = shape.properties.map(property => renderProperty(property, profile.layout));
    const propertyLines = properties.map((property, index) =>
      `${property}${index === properties.length - 1 && !shape.or ? ' .' : ' ;'}`);
    if (shape.or) propertyLines.push(`${renderOr(shape.or)} .`);
    return `<${shape.iri}>\n    a sh:NodeShape ;\n${propertyLines.join('\n')}\n`;
  });
  return `${header}${shapes.join('\n')}`;
}
