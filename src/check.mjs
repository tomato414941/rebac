// Checking: does subject S have permission (or relation) P on object O? Answered by walking the schema's
// expressions over relationships the caller keeps. The caller provides `read(object, relation)`, returning the
// subjects recorded for that relation on that object: each { type, id } or { type, id, relation } for a set. It
// may return the rows or a promise of them; check() then answers in kind, a value or a promise.
//
// An object or subject is { type, id }; a set subject is { type, id, relation } (every subject with that relation
// on that object). Evaluation is membership: whether S is in the set the expression denotes. Walks are bounded
// in depth so a cycle in the data cannot run forever.
const DEPTH = 32;
const isPromise = value => value && typeof value.then === 'function';
// Runs the generator-based walk: each yielded value is either rows (or a promise of rows) to await, and the
// generator's return is the answer. Stays synchronous as long as nothing yielded is a promise.
function drive(generator) {
  let step = generator.next();
  while (!step.done) {
    const value = step.value;
    if (isPromise(value)) return value.then(async resolved => {
      let next = generator.next(resolved);
      while (!next.done) next = generator.next(await next.value);
      return next.value;
    });
    step = generator.next(value);
  }
  return step.value;
}

export class Checker {
  constructor(schema, read, { depth = DEPTH } = {}) {
    this.schema = schema; this.read = read; this.depth = depth;
  }
  // The computed or recorded set named `name` on `object`.
  expressionOf(object, name) {
    const definition = this.schema.definitions.get(object.type);
    if (!definition) throw new Error(`unknown type ${object.type}`);
    if (definition.relations.has(name)) return { op: 'this', relation: name };
    const permission = definition.permissions.get(name);
    if (!permission) throw new Error(`${object.type} has no ${name}`);
    return permission.expression;
  }
  check(object, name, subject) {
    return drive(this.member(object, this.expressionOf(object, name), subject, this.depth));
  }
  * member(object, node, subject, depth) {
    if (depth <= 0) throw new Error('relationship depth exceeded');
    switch (node.op) {
      case 'nil': return false;
      case 'union': { for (const part of node.of) if (yield* this.member(object, part, subject, depth)) return true; return false; }
      case 'intersection': { for (const part of node.of) if (!(yield* this.member(object, part, subject, depth))) return false; return true; }
      case 'exclusion': return (yield* this.member(object, node.of[0], subject, depth)) && !(yield* this.member(object, node.of[1], subject, depth));
      case 'this': {
        // A bare name is a relation of this type, or a permission of it (named in another permission's expression).
        const definition = this.schema.definitions.get(object.type);
        if (definition?.permissions.has(node.relation) && !definition.relations.has(node.relation)) return yield* this.member(object, definition.permissions.get(node.relation).expression, subject, depth);
        return yield* this.inRelation(object, node.relation, subject, depth);
      }
      case 'arrow': {
        // Through each subject recorded for the relation, to that subject's own set of the same name.
        for (const through of yield this.read(object, node.through)) {
          if (through.relation) continue; // a set as the left side of an arrow is not followed (as SpiceDB)
          const target = { type: through.type, id: through.id };
          if (!this.schema.definitions.get(target.type)) continue;
          if (yield* this.member(target, this.expressionOf(target, node.to), subject, depth - 1)) return true;
        }
        return false;
      }
      default: throw new Error(`unknown expression ${node.op}`);
    }
  }
  // Recorded directly, or through a set subject: every subject with that relation on that object.
  * inRelation(object, relation, subject, depth) {
    for (const recorded of yield this.read(object, relation)) {
      if (!recorded.relation) { if (recorded.type === subject.type && recorded.id === subject.id) return true; continue; }
      const set = { type: recorded.type, id: recorded.id };
      if (!this.schema.definitions.get(set.type)) continue;
      if (yield* this.member(set, this.expressionOf(set, recorded.relation), subject, depth - 1)) return true;
    }
    return false;
  }
}
