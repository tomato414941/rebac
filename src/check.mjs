// Checking: does subject S have permission (or relation) P on object O? Answered by walking the schema's
// expressions over relationships the caller keeps. The caller provides `read(object, relation)`, returning the
// subjects recorded for that relation on that object: each { type, id } or { type, id, relation } for a set.
//
// An object or subject is { type, id }; a set subject is { type, id, relation } (every subject with that relation
// on that object). Evaluation is membership: whether S is in the set the expression denotes. Walks are bounded
// in depth so a cycle in the data cannot run forever.
const DEPTH = 32;

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
  async check(object, name, subject) {
    return this.member(object, this.expressionOf(object, name), subject, this.depth);
  }
  async member(object, node, subject, depth) {
    if (depth <= 0) throw new Error('relationship depth exceeded');
    switch (node.op) {
      case 'nil': return false;
      case 'union': { for (const part of node.of) if (await this.member(object, part, subject, depth)) return true; return false; }
      case 'intersection': { for (const part of node.of) if (!await this.member(object, part, subject, depth)) return false; return true; }
      case 'exclusion': return await this.member(object, node.of[0], subject, depth) && !await this.member(object, node.of[1], subject, depth);
      case 'this': return this.inRelation(object, node.relation, subject, depth);
      case 'arrow': {
        // Through each subject recorded for the relation, to that subject's own set of the same name.
        for (const through of await this.read(object, node.through)) {
          if (through.relation) continue; // a set as the left side of an arrow is not followed (as SpiceDB)
          const target = { type: through.type, id: through.id };
          if (!this.schema.definitions.get(target.type)) continue;
          if (await this.member(target, this.expressionOf(target, node.to), subject, depth - 1)) return true;
        }
        return false;
      }
      default: throw new Error(`unknown expression ${node.op}`);
    }
  }
  // Recorded directly, or through a set subject: every subject with that relation on that object.
  async inRelation(object, relation, subject, depth) {
    for (const recorded of await this.read(object, relation)) {
      if (!recorded.relation) { if (recorded.type === subject.type && recorded.id === subject.id) return true; continue; }
      const set = { type: recorded.type, id: recorded.id };
      if (!this.schema.definitions.get(set.type)) continue;
      if (await this.member(set, this.expressionOf(set, recorded.relation), subject, depth - 1)) return true;
    }
    return false;
  }
}
