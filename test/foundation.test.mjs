import test from 'node:test';
import assert from 'node:assert/strict';
import { rebac } from '../src/index.mjs';

// A model shaped like Foundation's: principals hold things; whoever stands as a principal (itself, its owner's
// stand-ins, its members') decides for it, its agents use what it holds, and any one action can be given on its own.
// The principal itself is its `self`, answered without a record.
const SCHEMA = `
  definition principal {
    relation self: principal
    relation owner: principal
    relation member: principal
    relation agent: principal
    relation reader: principal
    permission stands = self + owner->stands + member->stands
    permission use = stands + agent->stands
    permission read = use + reader->stands
    permission delete = self + owner->stands
  }
  definition variable {
    relation owner: principal
    relation reader: principal
    relation editor: principal
    relation sharer: principal
    relation user: principal
    permission read = owner->use + reader->stands
    permission update = owner->use + editor->stands
    permission share = owner->stands + sharer->stands
    permission use = owner->use + user->stands
    permission rename = update & share
  }
`;
const p = id => ({ type: 'principal', id });
const v = id => ({ type: 'variable', id });
function model(...tuples) {
  const rows = tuples.map(([object, relation, subject]) => ({ object, relation, subject }));
  const read = (object, relation) => relation === 'self' && object.type === 'principal' ? [p(object.id)]
    : rows.filter(row => row.object.type === object.type && row.object.id === object.id && row.relation === relation).map(row => row.subject);
  const reverse = (type, relation, subjects) => relation === 'self' && type === 'principal'
    ? subjects.filter(subject => subject.type === 'principal' && !subject.relation).map(subject => subject.id)
    : rows.filter(row => row.object.type === type && row.relation === relation &&
      subjects.some(subject => subject.type === row.subject.type && subject.id === row.subject.id)).map(row => row.object.id);
  return rebac(SCHEMA, read, { reverse });
}
const sorted = values => [...values].sort();
const ids = subjects => subjects.map(subject => subject.id).sort();

const world = () => model(
  [p('ai'), 'owner', p('me')], [p('me'), 'agent', p('ai')], [p('team'), 'member', p('me')],
  [v('db'), 'owner', p('me')], [v('db'), 'user', p('friend')], [v('wiki'), 'owner', p('team')],
);

test('本人としてふるまえる者は決め、代理は使えるが決められず、渡された操作はその物でだけできる', () => {
  const authz = world();
  assert.equal(authz.check(v('db'), 'use', p('ai')), true, 'the agent uses what its principal holds');
  assert.equal(authz.check(v('db'), 'share', p('ai')), false, 'but does not decide for it');
  assert.equal(authz.check(v('db'), 'rename', p('ai')), false, 'renaming takes both changing and deciding');
  assert.equal(authz.check(v('db'), 'rename', p('me')), true);
  assert.equal(authz.check(v('db'), 'use', p('friend')), true, 'one action given on its own');
  assert.equal(authz.check(v('db'), 'read', p('friend')), false, 'and nothing more');
  assert.equal(authz.check(v('wiki'), 'share', p('me')), true, 'a member stands as its group');
  assert.equal(authz.check(p('ai'), 'delete', p('me')), true, 'the owner may end what it owns');
  assert.equal(authz.check(p('ai'), 'delete', p('ai')), true, 'and a principal may end itself');
  assert.equal(authz.check(p('me'), 'delete', p('ai')), false);
});

test('ふるまえるプリンシパルと使える物、ある者としてふるまえる主体をすべて求める', () => {
  const authz = world();
  assert.deepEqual(sorted(authz.lookupResources('principal', 'stands', p('me'))), ['ai', 'me', 'team']);
  assert.deepEqual(sorted(authz.lookupResources('variable', 'use', p('ai'))), ['db']);
  assert.deepEqual(sorted(authz.lookupResources('variable', 'share', p('me'))), ['db', 'wiki']);
  assert.deepEqual(sorted(authz.lookupResources('variable', 'use', p('friend'))), ['db']);
  assert.deepEqual(ids(authz.lookupSubjects(p('team'), 'stands')), ['me', 'team']);
  assert.deepEqual(ids(authz.lookupSubjects(p('ai'), 'stands')), ['ai', 'me']);
  assert.deepEqual(ids(authz.lookupSubjects(v('db'), 'use')), ['ai', 'friend', 'me']);
});
