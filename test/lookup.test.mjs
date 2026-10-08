import test from 'node:test';
import assert from 'node:assert/strict';
import { rebac } from '../src/index.mjs';

// Relationships kept as rows (object#relation@subject, a set subject written subject#relation), read both ways:
// forwards for check and subjects, backwards for resources.
function store(...tuples) {
  const parse = ref => { const [type, id] = ref.split(':'); return { type, id }; };
  const kept = tuples.map(tuple => {
    const [left, right] = tuple.split('@');
    const [object, relation] = left.split('#');
    const [subject, subjectRelation] = right.split('#');
    return { ...parse(object), relation, subject: { ...parse(subject), ...(subjectRelation ? { relation: subjectRelation } : {}) } };
  });
  const same = (a, b) => a.type === b.type && a.id === b.id && (a.relation ?? null) === (b.relation ?? null);
  return {
    read: (object, relation) => kept.filter(row => row.type === object.type && row.id === object.id && row.relation === relation).map(row => row.subject),
    reverse: (type, relation, subjects) => [...new Set(kept.filter(row => row.type === type && row.relation === relation &&
      subjects.some(subject => same(subject, row.subject))).map(row => row.id))],
  };
}
const user = id => ({ type: 'user', id });
const doc = id => ({ type: 'document', id });
const sorted = values => [...values].sort();
const names = subjects => subjects.map(subject => subject.type + ':' + subject.id).sort();

const SCHEMA = `
  definition user {}
  definition group {
    relation member: user | group#member
  }
  definition folder {
    relation viewer: user | group#member
    relation parent: folder
    permission read = viewer + parent->read
  }
  definition document {
    relation owner: user
    relation viewer: user | group#member
    relation banned: user
    relation parent: folder
    permission read = (owner + viewer + parent->read) - banned
    permission edit = owner & viewer
  }
`;
const lookup = (...tuples) => { const { read, reverse } = store(...tuples); return rebac(SCHEMA, read, { reverse }); };

test('主体が権限を持つ対象を、和・積・差を通してすべて求める', () => {
  const authz = lookup('document:a#owner@user:anne', 'document:b#viewer@user:anne', 'document:c#viewer@user:anne',
    'document:c#banned@user:anne', 'document:d#owner@user:bob', 'document:e#owner@user:anne', 'document:e#viewer@user:anne');
  assert.deepEqual(sorted(authz.lookupResources('document', 'read', user('anne'))), ['a', 'b', 'e']);
  assert.deepEqual(sorted(authz.lookupResources('document', 'edit', user('anne'))), ['e']);
  assert.deepEqual(sorted(authz.lookupResources('document', 'owner', user('bob'))), ['d'], 'a relation itself');
  assert.deepEqual(authz.lookupResources('document', 'read', user('carol')), []);
});

test('入れ子のグループと親フォルダの連鎖をたどって、読める対象を求める', () => {
  const authz = lookup('group:eng#member@group:platform#member', 'group:platform#member@user:bob',
    'folder:f0#viewer@group:eng#member', 'folder:f1#parent@folder:f0', 'document:a#parent@folder:f1', 'document:b#parent@folder:f0',
    'document:c#viewer@user:anne');
  assert.deepEqual(sorted(authz.lookupResources('document', 'read', user('bob'))), ['a', 'b']);
  assert.deepEqual(sorted(authz.lookupResources('folder', 'read', user('bob'))), ['f0', 'f1']);
  assert.deepEqual(sorted(authz.lookupResources('group', 'member', user('bob'))), ['eng', 'platform']);
});

test('対象に権限を持つ主体を、集合と矢印を通してすべて求め、除かれた主体は含めない', () => {
  const authz = lookup('document:a#owner@user:anne', 'document:a#viewer@group:eng#member', 'group:eng#member@user:bob',
    'group:eng#member@group:platform#member', 'group:platform#member@user:carol', 'document:a#parent@folder:f',
    'folder:f#viewer@user:dave', 'document:a#banned@user:carol');
  assert.deepEqual(names(authz.lookupSubjects(doc('a'), 'read')), ['user:anne', 'user:bob', 'user:dave']);
  assert.deepEqual(names(authz.lookupSubjects(doc('a'), 'edit')), []);
  assert.deepEqual(names(authz.lookupSubjects({ type: 'group', id: 'eng' }, 'member')), ['user:bob', 'user:carol']);
});

test('循環する関係でも、見つかるものがなくなった時点で止まる', () => {
  const authz = lookup('group:a#member@group:b#member', 'group:b#member@group:a#member', 'group:b#member@user:anne',
    'document:x#viewer@group:a#member');
  assert.deepEqual(authz.lookupResources('document', 'read', user('anne')), ['x']);
  assert.deepEqual(sorted(authz.lookupResources('group', 'member', user('anne'))), ['a', 'b']);
  assert.deepEqual(names(authz.lookupSubjects(doc('x'), 'read')), ['user:anne']);
});

test('読む側が同期なら同期で、非同期なら非同期で答える', async () => {
  const { read, reverse } = store('document:a#owner@user:anne');
  const now = rebac(SCHEMA, read, { reverse });
  assert.deepEqual(now.lookupResources('document', 'read', user('anne')), ['a']);
  assert.deepEqual(names(now.lookupSubjects(doc('a'), 'read')), ['user:anne']);
  const later = rebac(SCHEMA, async (...args) => read(...args), { reverse: async (...args) => reverse(...args) });
  const pending = later.lookupResources('document', 'read', user('anne'));
  assert.equal(typeof pending.then, 'function');
  assert.deepEqual(await pending, ['a']);
  assert.deepEqual(names(await later.lookupSubjects(doc('a'), 'read')), ['user:anne']);
});

test('同じ読み取りは一度の検索の中で一回だけ頼む', () => {
  const { read, reverse } = store('group:eng#member@user:anne', 'folder:f#viewer@group:eng#member',
    'document:a#parent@folder:f', 'document:b#parent@folder:f');
  const asked = [];
  const authz = rebac(SCHEMA, read, { reverse: (...args) => { asked.push(JSON.stringify(args)); return reverse(...args); } });
  assert.deepEqual(sorted(authz.lookupResources('document', 'read', user('anne'))), ['a', 'b']);
  assert.equal(new Set(asked).size, asked.length);
});

test('逆向きの読み手がなければ、対象の検索は誤りを返し、知らない名前も誤りを返す', () => {
  const { read, reverse } = store();
  assert.throws(() => rebac(SCHEMA, read).lookupResources('document', 'read', user('anne')), /reverse reader/);
  const authz = rebac(SCHEMA, read, { reverse });
  assert.throws(() => authz.lookupResources('nothing', 'read', user('anne')), /unknown type/);
  assert.throws(() => authz.lookupSubjects(doc('a'), 'fly'), /has no fly/);
});
