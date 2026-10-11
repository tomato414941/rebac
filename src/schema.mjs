// The SpiceDB schema language, read into definitions: what types there are, which relations each records (and
// what may be the subject of each), and which permissions each computes from them. Only what is written is
// accepted; a reference to a type or relation that does not exist is an error when the schema is read, not later,
// and so is a permission that comes back to itself through permissions alone.
//
//   definition document {
//     relation owner: user | group#member
//     permission read = owner + viewer + parent->read
//   }
//
// Permission expressions: + (union), & (intersection), - (exclusion), -> (through a relation, to the subjects'
// permission or relation of that name), parentheses, and nil. Union binds loosest; & and - bind tighter and
// associate left. Caveats, wildcards, `use` directives and permission type annotations are not read.
const IDENT = /^[a-z_][a-z0-9_]*$/;

class SchemaError extends Error {
  constructor(message, at) { super(message + (at ? ` (line ${at.line})` : '')); this.name = 'SchemaError'; this.line = at?.line; }
}

// Tokens: identifiers (with / and # kept inside them), punctuation, and the arrow.
function tokenize(text) {
  const tokens = [];
  let line = 1;
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    let m;
    if ((m = /^\n/.exec(rest))) { line++; i++; continue; }
    if ((m = /^[ \t\r]+/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^\/\/[^\n]*/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^\/\*[\s\S]*?\*\//.exec(rest))) { line += m[0].split('\n').length - 1; i += m[0].length; continue; }
    if ((m = /^->/.exec(rest))) { tokens.push({ kind: '->', line }); i += 2; continue; }
    if ((m = /^[{}=+&|():#]/.exec(rest))) { tokens.push({ kind: m[0], line }); i += 1; continue; }
    if ((m = /^-/.exec(rest))) { tokens.push({ kind: '-', line }); i += 1; continue; }
    if ((m = /^[a-zA-Z_][a-zA-Z0-9_/]*/.exec(rest))) { tokens.push({ kind: 'ident', value: m[0], line }); i += m[0].length; continue; }
    throw new SchemaError(`unexpected character ${JSON.stringify(rest[0])}`, { line });
  }
  return tokens;
}

export function parseSchema(text) {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expect = (kind, what = kind) => {
    const token = next();
    if (!token || token.kind !== kind) throw new SchemaError(`expected ${what}`, token ?? tokens[at - 2]);
    return token;
  };
  const ident = what => {
    const token = expect('ident', what);
    const name = token.value.includes('/') ? token.value.slice(token.value.lastIndexOf('/') + 1) : token.value;
    if (!IDENT.test(name) || name.length < 1 || name.length > 64 || !/[a-z0-9]$/.test(name)) throw new SchemaError(`invalid ${what} ${token.value}`, token);
    return token.value;
  };

  // A permission expression, by precedence: union of terms; a term is an operand joined by & or - (left to right).
  function expression() {
    const parts = [term()];
    while (peek()?.kind === '+') { next(); parts.push(term()); }
    return parts.length === 1 ? parts[0] : { op: 'union', of: parts };
  }
  function term() {
    let left = operand();
    while (peek()?.kind === '&' || peek()?.kind === '-') {
      const op = next().kind === '&' ? 'intersection' : 'exclusion';
      left = { op, of: [left, operand()] };
    }
    return left;
  }
  function operand() {
    if (peek()?.kind === '(') { next(); const inner = expression(); expect(')'); return inner; }
    const token = expect('ident', 'a relation, permission or nil');
    if (token.value === 'nil') return { op: 'nil' };
    if (!IDENT.test(token.value)) throw new SchemaError(`invalid name ${token.value}`, token);
    if (peek()?.kind === '->') { next(); const target = ident('a relation or permission after ->'); return { op: 'arrow', through: token.value, to: target }; }
    return { op: 'this', relation: token.value };
  }

  const definitions = new Map();
  while (peek()) {
    const word = next();
    if (word.kind !== 'ident' || !['definition', 'caveat', 'use'].includes(word.value)) throw new SchemaError('expected definition', word);
    if (word.value === 'use') { ident('a directive'); continue; }
    if (word.value === 'caveat') throw new SchemaError('caveats are not supported', word);
    const name = ident('a definition name');
    if (definitions.has(name)) throw new SchemaError(`definition ${name} is declared twice`, word);
    expect('{');
    const relations = new Map(), permissions = new Map();
    while (peek() && peek().kind !== '}') {
      const kind = next();
      if (kind.kind !== 'ident' || !['relation', 'permission'].includes(kind.value)) throw new SchemaError('expected relation or permission', kind);
      const member = ident(`a ${kind.value} name`);
      if (relations.has(member) || permissions.has(member)) throw new SchemaError(`${member} is declared twice in ${name}`, kind);
      if (kind.value === 'relation') {
        expect(':');
        const subjects = [];
        do {
          const type = ident('a subject type');
          if (peek()?.kind === ':') throw new SchemaError('wildcards are not supported', peek());
          let relation = null;
          if (peek()?.kind === '#') { next(); relation = ident('a subject relation'); }
          subjects.push({ type, relation });
        } while (peek()?.kind === '|' && next());
        relations.set(member, { subjects, line: kind.line });
      } else {
        if (peek()?.kind === ':') throw new SchemaError('permission type annotations are not supported', peek());
        expect('=');
        permissions.set(member, { expression: expression(), line: kind.line });
      }
    }
    expect('}');
    definitions.set(name, { relations, permissions });
  }
  check(definitions);
  return { definitions };
}

// Every reference must land: subject types, subject relations, and every name a permission uses. An arrow's left
// side must be a relation; what it reaches must exist on every type that relation's subjects may be.
function check(definitions) {
  const member = (type, name) => definitions.get(type)?.relations.has(name) || definitions.get(type)?.permissions.has(name);
  for (const [type, { relations, permissions }] of definitions) {
    for (const [name, { subjects, line }] of relations) for (const subject of subjects) {
      if (!definitions.has(subject.type)) throw new SchemaError(`relation ${type}#${name}: unknown type ${subject.type}`, { line });
      if (subject.relation && !member(subject.type, subject.relation)) throw new SchemaError(`relation ${type}#${name}: ${subject.type} has no ${subject.relation}`, { line });
    }
    const walk = (node, line, name) => {
      if (node.op === 'nil') return;
      if (node.op === 'this') { if (!member(type, node.relation)) throw new SchemaError(`permission ${type}#${name}: ${type} has no ${node.relation}`, { line }); return; }
      if (node.op === 'arrow') {
        const through = relations.get(node.through);
        if (!through) throw new SchemaError(`permission ${type}#${name}: ${node.through} must be a relation of ${type} to use ->`, { line });
        for (const subject of through.subjects) {
          const landing = subject.type;
          if (!member(landing, node.to)) throw new SchemaError(`permission ${type}#${name}: ${landing} has no ${node.to} for ${node.through}->${node.to}`, { line });
        }
        return;
      }
      for (const part of node.of) walk(part, line, name);
    };
    for (const [name, { expression, line }] of permissions) walk(expression, line, name);
    // A permission may not come back to itself through permissions of its type alone: with no relation or arrow on
    // the way, no record is ever read to end the walk.
    const uses = node => node.op === 'this' ? (permissions.has(node.relation) ? [node.relation] : []) : (node.of ?? []).flatMap(uses);
    const settled = new Set();
    const follow = (name, trail) => {
      if (settled.has(name)) return;
      const at = trail.indexOf(name);
      if (at >= 0) throw new SchemaError(`permission ${type}#${name} refers back to itself: ${[...trail.slice(at), name].join(' -> ')}`, { line: permissions.get(name).line });
      for (const next of uses(permissions.get(name).expression)) follow(next, [...trail, name]);
      settled.add(name);
    };
    for (const name of permissions.keys()) follow(name, []);
  }
}

export { SchemaError };
