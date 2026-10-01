import test from 'node:test';
import assert from 'node:assert/strict';
import { rebac } from '../src/index.mjs';

// Relationships kept as rows: object#relation@subject, with a set subject written subject#relation.
function rows(...tuples) {
  const kept = tuples.map(tuple => {
    const [left, right] = tuple.split('@');
    const [object, relation] = left.split('#');
    const [subject, subjectRelation] = right.split('#');
    const parse = ref => { const [type, id] = ref.split(':'); return { type, id }; };
    return { ...parse(object), relation, subject: { ...parse(subject), ...(subjectRelation ? { relation: subjectRelation } : {}) } };
  });
  return (object, relation) => kept.filter(row => row.type === object.type && row.id === object.id && row.relation === relation).map(row => row.subject);
}
const user = id => ({ type: 'user', id });
const doc = id => ({ type: 'document', id });

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

test('記録された関係と、和・積・差で計算する権限を答える', async () => {
  const authz = rebac(SCHEMA, rows('document:a#owner@user:anne', 'document:a#viewer@user:bob', 'document:a#viewer@user:carol', 'document:a#banned@user:carol'));
  assert.equal(await authz.check(doc('a'), 'owner', user('anne')), true, 'a relation itself');
  assert.equal(await authz.check(doc('a'), 'read', user('anne')), true);
  assert.equal(await authz.check(doc('a'), 'read', user('bob')), true);
  assert.equal(await authz.check(doc('a'), 'read', user('carol')), false, 'excluded');
  assert.equal(await authz.check(doc('a'), 'read', user('dave')), false);
  assert.equal(await authz.check(doc('a'), 'edit', user('anne')), false, 'owner but not viewer');
});

test('集合を主体にした関係は、入れ子のグループまでたどる', async () => {
  const authz = rebac(SCHEMA, rows('document:a#viewer@group:eng#member', 'group:eng#member@user:anne', 'group:eng#member@group:platform#member', 'group:platform#member@user:bob'));
  assert.equal(await authz.check(doc('a'), 'read', user('anne')), true);
  assert.equal(await authz.check(doc('a'), 'read', user('bob')), true, 'through a nested group');
  assert.equal(await authz.check(doc('a'), 'read', user('carol')), false);
});

test('矢印は関係の先の対象の権限をたどり、親の親まで届く', async () => {
  const authz = rebac(SCHEMA, rows('document:a#parent@folder:f1', 'folder:f1#parent@folder:f0', 'folder:f0#viewer@user:anne'));
  assert.equal(await authz.check(doc('a'), 'read', user('anne')), true);
  assert.equal(await authz.check({ type: 'folder', id: 'f1' }, 'read', user('anne')), true);
  assert.equal(await authz.check(doc('a'), 'read', user('bob')), false);
});

test('循環する関係でも止まり、深さの上限で誤りを返す', () => {
  const authz = rebac(SCHEMA, rows('group:a#member@group:b#member', 'group:b#member@group:a#member', 'document:a#viewer@group:a#member'));
  assert.throws(() => authz.check(doc('a'), 'read', user('anne')), /depth/);
});

test('知らない型や名前を聞かれたら誤りを返す', () => {
  const authz = rebac(SCHEMA, rows());
  assert.throws(() => authz.check({ type: 'nothing', id: 'x' }, 'read', user('anne')), /unknown type/);
  assert.throws(() => authz.check(doc('a'), 'fly', user('anne')), /has no fly/);
});

test('関係を読む側は非同期でもよい', async () => {
  const authz = rebac(SCHEMA, async (object, relation) => object.id === 'a' && relation === 'owner' ? [user('anne')] : []);
  assert.equal(await authz.check(doc('a'), 'read', user('anne')), true);
});

test('権限の式はほかの権限を名前で参照でき、同期の読み手には同期で答える', () => {
  const schema = 'definition user {} definition d { relation owner: user permission manage = owner permission remove = manage }';
  const authz = rebac(schema, (object, relation) => relation === 'owner' ? [user('anne')] : []);
  assert.equal(authz.check(doc('x').type === 'document' ? { type: 'd', id: 'x' } : null, 'remove', user('anne')), true);
  assert.equal(authz.check({ type: 'd', id: 'x' }, 'remove', user('bob')), false);
});
