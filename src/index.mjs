import { parseSchema, SchemaError } from './schema.mjs';
import { Checker } from './check.mjs';
import { Lookup } from './lookup.mjs';

// Relationship-based authorization in your own process. Read a schema in the SpiceDB language, keep relationships
// wherever you like, and ask whether a subject has a permission on an object; for a list, every object of a type
// it has the permission on, or every subject that has it on an object.
//
//   const authz = rebac(schemaText, (object, relation) => rowsFor(object, relation),
//     { reverse: (type, relation, subjects) => idsOf(type, relation, subjects) });
//   await authz.check({ type: 'document', id: 'readme' }, 'read', { type: 'user', id: 'anne' });
//   await authz.lookupResources('document', 'read', { type: 'user', id: 'anne' });
//   await authz.lookupSubjects({ type: 'document', id: 'readme' }, 'read');
export function rebac(schemaText, read, options = {}) {
  const schema = typeof schemaText === 'string' ? parseSchema(schemaText) : schemaText;
  const checker = new Checker(schema, read, options), lookup = new Lookup(schema, read, options.reverse, options);
  return {
    schema,
    check: (object, name, subject) => checker.check(object, name, subject),
    lookupResources: (type, name, subject) => lookup.resources(type, name, subject),
    lookupSubjects: (object, name) => lookup.subjects(object, name),
  };
}
export { parseSchema, SchemaError, Checker, Lookup };
