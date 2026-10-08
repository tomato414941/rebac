export interface ObjectRef { type: string; id: string }
// A subject recorded for a relation: one object, or a set (every subject with `relation` on that object).
export interface SubjectRef extends ObjectRef { relation?: string }
type Answer<T> = T | Promise<T>;
// The subjects recorded for a relation on an object.
export type Reader = (object: ObjectRef, relation: string) => Answer<readonly SubjectRef[]>;
// The ids of the objects of a type with any of these subjects recorded for the relation.
export type ReverseReader = (type: string, relation: string, subjects: SubjectRef[]) => Answer<readonly (string | { id: string })[]>;
export interface Options { reverse?: ReverseReader; depth?: number }

export type Expression =
  | { op: 'nil' }
  | { op: 'this'; relation: string }
  | { op: 'arrow'; through: string; to: string }
  | { op: 'union' | 'intersection' | 'exclusion'; of: Expression[] };
export interface Definition {
  relations: Map<string, { subjects: { type: string; relation: string | null }[]; line: number }>;
  permissions: Map<string, { expression: Expression; line: number }>;
}
export interface Schema { definitions: Map<string, Definition> }
export class SchemaError extends Error { line?: number }
export function parseSchema(text: string): Schema;

export interface Rebac {
  schema: Schema;
  check(object: ObjectRef, name: string, subject: ObjectRef): Answer<boolean>;
  lookupResources(type: string, name: string, subject: ObjectRef): Answer<string[]>;
  lookupSubjects(object: ObjectRef, name: string): Answer<ObjectRef[]>;
}
export function rebac(schema: string | Schema, read: Reader, options?: Options): Rebac;
