// Checking: does subject S have permission (or relation) P on object O? Answered by walking the schema's
// expressions over relationships the caller keeps. The caller provides `read(object, relation)`, returning the
// subjects recorded for that relation on that object: each { type, id } or { type, id, relation } for a set. It
// may return the rows or a promise of them; check() then answers in kind, a value or a promise. A row whose
// subject the schema does not allow for that relation counts for nothing.
//
// An object or subject is { type, id }; a set subject is { type, id, relation } (every subject with that relation
// on that object). Evaluation is membership: whether S is in the set the expression denotes. A walk that comes
// back to a set it is still inside stops there, and walks are bounded in depth.
import { drive } from './drive.mjs';

export const DEPTH = 32;

// The computed or recorded set named `name` on objects of `type`.
export function expressionOf(schema, type, name) {
  const definition = schema.definitions.get(type);
  if (!definition) throw new Error(`unknown type ${type}`);
  if (definition.relations.has(name)) return { op: 'this', relation: name };
  const permission = definition.permissions.get(name);
  if (!permission) throw new Error(`${type} has no ${name}`);
  return permission.expression;
}

// The rows read for a relation whose subject the schema allows there: an allowed type, and for a set, an allowed
// relation of it.
export function allowedRows(schema, type, relation, rows) {
  const subjects = schema.definitions.get(type).relations.get(relation).subjects;
  return [...rows].filter(row => subjects.some(subject => subject.type === row.type && subject.relation === (row.relation ?? null)));
}

export class Checker {
  constructor(schema, read, { depth = DEPTH } = {}) {
    this.schema = schema; this.read = read; this.depth = depth;
  }
  expressionOf(object, name) {
    return expressionOf(this.schema, object.type, name);
  }
  check(object, name, subject) {
    this.expressionOf(object, name);
    return drive(this.named(object, name, subject, this.depth, { open: new Map(), subtracting: [] }));
  }
  // The set named `name` on `object`. Coming back to a set the walk is still inside adds no subject the walk cannot
  // reach another way, so that branch reaches none. Coming back through the side an exclusion subtracts would let a
  // set decide its own exclusion, which has no answer.
  * named(object, name, subject, depth, path) {
    if (depth <= 0) throw new Error('relationship depth exceeded');
    const key = object.type + ':' + object.id + '#' + name, at = path.open.get(key);
    if (at !== undefined) {
      if (path.subtracting.some(start => at < start)) throw new Error(`relationship cycle through an exclusion at ${key}`);
      return false;
    }
    path.open.set(key, path.open.size);
    try {
      if (this.schema.definitions.get(object.type).relations.has(name)) return yield* this.inRelation(object, name, subject, depth, path);
      return yield* this.member(object, this.expressionOf(object, name), subject, depth, path);
    } finally {
      path.open.delete(key);
    }
  }
  * member(object, node, subject, depth, path) {
    switch (node.op) {
      case 'nil': return false;
      case 'union': { for (const part of node.of) if (yield* this.member(object, part, subject, depth, path)) return true; return false; }
      case 'intersection': { for (const part of node.of) if (!(yield* this.member(object, part, subject, depth, path))) return false; return true; }
      case 'exclusion': {
        if (!(yield* this.member(object, node.of[0], subject, depth, path))) return false;
        path.subtracting.push(path.open.size);
        try { return !(yield* this.member(object, node.of[1], subject, depth, path)); } finally { path.subtracting.pop(); }
      }
      // A bare name is a relation of this type, or a permission of it (named in another permission's expression).
      case 'this': return yield* this.named(object, node.relation, subject, depth, path);
      case 'arrow': {
        // Through each subject recorded for the relation, to that subject's own set of the same name. A set subject
        // leads to its object, its relation ignored, as SpiceDB does.
        for (const through of allowedRows(this.schema, object.type, node.through, yield this.read(object, node.through))) {
          if (yield* this.named({ type: through.type, id: through.id }, node.to, subject, depth - 1, path)) return true;
        }
        return false;
      }
      default: throw new Error(`unknown expression ${node.op}`);
    }
  }
  // Recorded directly, or through a set subject: every subject with that relation on that object.
  * inRelation(object, relation, subject, depth, path) {
    for (const recorded of allowedRows(this.schema, object.type, relation, yield this.read(object, relation))) {
      if (!recorded.relation) { if (recorded.type === subject.type && recorded.id === subject.id) return true; continue; }
      if (yield* this.named({ type: recorded.type, id: recorded.id }, recorded.relation, subject, depth - 1, path)) return true;
    }
    return false;
  }
}
