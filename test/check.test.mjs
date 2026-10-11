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

test('循環する入れ子でも、届く経路があれば記録の並び順によらず権限があると答える', () => {
  const authz = rebac(SCHEMA, rows('group:a#member@group:b#member', 'group:a#member@user:anne', 'group:b#member@group:a#member', 'document:a#viewer@group:b#member'));
  assert.equal(authz.check({ type: 'group', id: 'a' }, 'member', user('anne')), true, 'a direct member recorded after the cycle');
  assert.equal(authz.check({ type: 'group', id: 'b' }, 'member', user('anne')), true);
  assert.equal(authz.check(doc('a'), 'read', user('anne')), true);
});

test('循環する入れ子で届かない主体には、権限がないと答える', () => {
  const authz = rebac(SCHEMA, rows('group:a#member@group:b#member', 'group:b#member@group:a#member', 'document:a#viewer@group:a#member'));
  assert.equal(authz.check(doc('a'), 'read', user('anne')), false);
});

test('深さの上限を超える入れ子では誤りを返す', () => {
  const authz = rebac(SCHEMA, rows('group:g0#member@group:g1#member', 'group:g1#member@group:g2#member', 'group:g2#member@group:g3#member', 'group:g3#member@user:anne'), { depth: 3 });
  assert.throws(() => authz.check({ type: 'group', id: 'g0' }, 'member', user('anne')), /depth/);
});

test('差で引かれる側を通って同じ集合に戻る循環には、答えずに誤りを返す', () => {
  const schema = 'definition user {} definition d { relation viewer: user relation blocker: d#view permission view = viewer - blocker }';
  const authz = rebac(schema, rows('d:x#viewer@user:anne', 'd:x#blocker@d:x#view'));
  assert.throws(() => authz.check({ type: 'd', id: 'x' }, 'view', user('anne')), /exclusion/);
});

test('同じ読み取りは一度の判定の中で一回だけ頼む', () => {
  // Two groups both hold the same group: a walk reaches group:d twice.
  const read = rows('group:a#member@group:b#member', 'group:a#member@group:c#member', 'group:b#member@group:d#member',
    'group:c#member@group:d#member', 'group:d#member@user:anne');
  const asked = [];
  const authz = rebac(SCHEMA, (object, relation) => { asked.push(object.type + ':' + object.id + '#' + relation); return read(object, relation); });
  assert.equal(authz.check({ type: 'group', id: 'a' }, 'member', user('bob')), false);
  assert.equal(new Set(asked).size, asked.length);
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
