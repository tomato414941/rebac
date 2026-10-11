// Looking up: what a list needs, answered from the same schema and relationships as check().
//
//   resources(type, name, subject): the ids of every object of a type on which the subject has the permission (or
//   relation) named. Found by walking each expression backwards with `reverse(type, relation, subjects)`, which
//   the caller provides: the ids of the objects of that type with any of those subjects recorded for the relation.
//   subjects(object, name): every subject that has it on that object, each { type, id }. Found by walking each
//   expression forwards with `read`, as check() does.
//
// Sets may reach themselves (an owner's owner, a group in a group): each starts empty and is computed again from
// the others until nothing changes, at most `depth` times. Readers may answer with rows or a promise of them; a
// lookup then answers in kind. The same read asked twice in one lookup is asked once.
import { drive, then } from './drive.mjs';
import { DEPTH, allowed, expressionOf } from './check.mjs';

const keyOf = ref => ref.type + ':' + ref.id + (ref.relation ? '#' + ref.relation : '');
const keep = (a, b) => new Map([...a].filter(([key]) => b.has(key)));
const without = (a, b) => new Map([...a].filter(([key]) => !b.has(key)));
const same = (a, b) => a.size === b.size && [...a.keys()].every(key => b.has(key));
const merge = (into, from) => { for (const [key, value] of from) into.set(key, value); return into; };

function once(read, keyOfCall) {
  const answers = new Map();
  return (...args) => {
    const key = keyOfCall(...args);
    if (!answers.has(key)) answers.set(key, read(...args));
    return answers.get(key);
  };
}

// The set a problem names, where sets depend on each other and on themselves. Every set starts empty; each round
// computes every known set again until it holds still, and the rounds end when one changes nothing.
function* solve(start, nameOf, evaluate, depth) {
  const problems = new Map([[nameOf(start), start]]), values = new Map([[nameOf(start), new Map()]]);
  let grown = false;
  const ref = problem => {
    const name = nameOf(problem);
    if (!values.has(name)) { problems.set(name, problem); values.set(name, new Map()); grown = true; }
    return values.get(name);
  };
  for (let round = 0; round < depth; round++) {
    let changed = false;
    for (const name of [...problems.keys()].reverse()) {
      for (let again = 0; ; again++) {
        if (again >= depth) throw new Error('relationship depth exceeded');
        grown = false;
        const next = yield* evaluate(problems.get(name), ref);
        const settled = same(next, values.get(name));
        values.set(name, next);
        if (grown) changed = true;
        if (settled) break;
        changed = true;
      }
    }
    if (!changed) return values.get(nameOf(start));
  }
  throw new Error('relationship depth exceeded');
}

export class Lookup {
  constructor(schema, read, reverse, { depth = DEPTH } = {}) {
    this.schema = schema; this.read = read; this.reverse = reverse; this.depth = depth;
  }
  resources(type, name, subject) {
    if (!this.reverse) throw new Error('looking up resources needs a reverse reader');
    expressionOf(this.schema, type, name);
    const reverse = once((...args) => this.reverse(...args),
      (objectType, relation, subjects) => objectType + '#' + relation + '@' + subjects.map(keyOf).sort().join(','));
    const found = drive(solve({ type, name }, problem => problem.type + '#' + problem.name,
      (problem, ref) => this.backward(problem.type, expressionOf(this.schema, problem.type, problem.name), subject, ref, reverse),
      this.depth));
    return then(found, ids => [...ids.keys()]);
  }
  subjects(object, name) {
    expressionOf(this.schema, object.type, name);
    const read = once((...args) => this.read(...args), (target, relation) => keyOf(target) + '#' + relation);
    const found = drive(solve({ object, name }, problem => keyOf(problem.object) + '#' + problem.name,
      (problem, ref) => this.forward(problem.object, expressionOf(this.schema, problem.object.type, problem.name), ref, read),
      this.depth));
    return then(found, subjects => [...subjects.values()]);
  }

  // The objects of `type` whose set `node` holds the subject.
  * backward(type, node, subject, ref, reverse) {
    const found = new Map(), add = rows => { for (const row of rows) { const id = typeof row === 'string' ? row : row.id; found.set(id, id); } };
    switch (node.op) {
      case 'nil': return found;
      case 'union': { for (const part of node.of) merge(found, yield* this.backward(type, part, subject, ref, reverse)); return found; }
      case 'intersection': {
        let kept = null;
        for (const part of node.of) { const next = yield* this.backward(type, part, subject, ref, reverse); kept = kept ? keep(kept, next) : next; }
        return kept ?? found;
      }
      case 'exclusion': {
        const base = yield* this.backward(type, node.of[0], subject, ref, reverse);
        return without(base, yield* this.backward(type, node.of[1], subject, ref, reverse));
      }
      case 'this': {
        const definition = this.schema.definitions.get(type);
        if (!definition.relations.has(node.relation)) return new Map(ref({ type, name: node.relation }));
        // Recorded directly, or through a set: the objects where a set recorded for it holds the subject.
        for (const allowed of definition.relations.get(node.relation).subjects) {
          if (!allowed.relation) {
            if (allowed.type === subject.type) add(yield reverse(type, node.relation, [{ type: subject.type, id: subject.id }]));
            continue;
          }
          const sets = ref({ type: allowed.type, name: allowed.relation });
          if (sets.size) add(yield reverse(type, node.relation, [...sets.keys()].map(id => ({ type: allowed.type, id, relation: allowed.relation }))));
        }
        return found;
      }
      case 'arrow': {
        // Through the subjects recorded for the relation that have the named set themselves (direct ones only, as check()).
        for (const allowed of this.schema.definitions.get(type).relations.get(node.through).subjects) {
          if (allowed.relation) continue;
          const through = ref({ type: allowed.type, name: node.to });
          if (through.size) add(yield reverse(type, node.through, [...through.keys()].map(id => ({ type: allowed.type, id }))));
        }
        return found;
      }
      default: throw new Error(`unknown expression ${node.op}`);
    }
  }

  // The subjects in the set `node` on `object`.
  * forward(object, node, ref, read) {
    const found = new Map();
    switch (node.op) {
      case 'nil': return found;
      case 'union': { for (const part of node.of) merge(found, yield* this.forward(object, part, ref, read)); return found; }
      case 'intersection': {
        let kept = null;
        for (const part of node.of) { const next = yield* this.forward(object, part, ref, read); kept = kept ? keep(kept, next) : next; }
        return kept ?? found;
      }
      case 'exclusion': {
        const base = yield* this.forward(object, node.of[0], ref, read);
        return without(base, yield* this.forward(object, node.of[1], ref, read));
      }
      case 'this': {
        if (!this.schema.definitions.get(object.type).relations.has(node.relation)) return new Map(ref({ object, name: node.relation }));
        for (const row of allowed(this.schema, object.type, node.relation, yield read(object, node.relation))) {
          if (!row.relation) { found.set(keyOf(row), { type: row.type, id: row.id }); continue; }
          merge(found, ref({ object: { type: row.type, id: row.id }, name: row.relation }));
        }
        return found;
      }
      case 'arrow': {
        for (const row of allowed(this.schema, object.type, node.through, yield read(object, node.through))) {
          if (row.relation) continue;
          merge(found, ref({ object: { type: row.type, id: row.id }, name: node.to }));
        }
        return found;
      }
      default: throw new Error(`unknown expression ${node.op}`);
    }
  }
}
