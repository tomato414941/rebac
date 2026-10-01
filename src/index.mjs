import { parseSchema, SchemaError } from './schema.mjs';
import { Checker } from './check.mjs';

// Relationship-based authorization in your own process. Read a schema in the SpiceDB language, keep relationships
// wherever you like, and ask whether a subject has a permission on an object.
//
//   const authz = rebac(schemaText, (object, relation) => rowsFor(object, relation));
//   await authz.check({ type: 'document', id: 'readme' }, 'read', { type: 'user', id: 'anne' });
export function rebac(schemaText, read, options) {
  const schema = typeof schemaText === 'string' ? parseSchema(schemaText) : schemaText;
  const checker = new Checker(schema, read, options);
  return { schema, check: (object, name, subject) => checker.check(object, name, subject) };
}
export { parseSchema, SchemaError, Checker };
