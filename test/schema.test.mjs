import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema, SchemaError } from '../src/schema.mjs';

test('定義・関係・権限を読み、主体の型と式を構造にする', () => {
  const { definitions } = parseSchema(`
    /** People. */
    definition user {}
    definition group { relation member: user | group#member }
    definition document {
      relation owner: user
      relation viewer: user | group#member // anyone in a group
      relation parent: folder
      permission read = owner + viewer + parent->read
      permission admin = (owner & viewer) - banned
      relation banned: user
      permission nothing = nil
    }
    definition folder { relation reader: user  permission read = reader }
  `);
  assert.deepEqual([...definitions.keys()], ['user', 'group', 'document', 'folder']);
  assert.deepEqual(definitions.get('group').relations.get('member').subjects, [{ type: 'user', relation: null }, { type: 'group', relation: 'member' }]);
  assert.deepEqual(definitions.get('document').permissions.get('read').expression,
    { op: 'union', of: [{ op: 'this', relation: 'owner' }, { op: 'this', relation: 'viewer' }, { op: 'arrow', through: 'parent', to: 'read' }] });
  assert.deepEqual(definitions.get('document').permissions.get('admin').expression,
    { op: 'exclusion', of: [{ op: 'intersection', of: [{ op: 'this', relation: 'owner' }, { op: 'this', relation: 'viewer' }] }, { op: 'this', relation: 'banned' }] });
  assert.deepEqual(definitions.get('document').permissions.get('nothing').expression, { op: 'nil' });
});

test('和は積と差より弱く結び、括弧で変えられる', () => {
  const { definitions } = parseSchema('definition d { relation a: d relation b: d relation c: d permission p = a + b & c permission q = (a + b) & c }');
  assert.equal(definitions.get('d').permissions.get('p').expression.op, 'union');
  assert.equal(definitions.get('d').permissions.get('q').expression.op, 'intersection');
});

test('名前空間の接頭辞を読み、use 指令を読み飛ばす', () => {
  const { definitions } = parseSchema('use self\ndefinition acme/user {}\ndefinition acme/doc { relation reader: acme/user }');
  assert.deepEqual(definitions.get('acme/doc').relations.get('reader').subjects, [{ type: 'acme/user', relation: null }]);
});

test('存在しない型・関係・権限への参照は、読んだ時点で誤りとして返す', () => {
  const cases = [
    ['definition d { relation r: nowhere }', /unknown type nowhere/],
    ['definition u {} definition d { relation r: u#member }', /u has no member/],
    ['definition d { permission p = ghost }', /d has no ghost/],
    ['definition u {} definition d { relation r: u permission p = r->read }', /u has no read/],
    ['definition d { permission p = q->x permission q = nil }', /q must be a relation/],
    ['definition d {} definition d {}', /declared twice/],
    ['definition d { relation r: d relation r: d }', /declared twice/],
    ['definition d { relation r: d: }', /not supported/],
    ['definition Doc {}', /invalid/],
    ['definition d { relation r: d permission p = r +', /expected/],
  ];
  for (const [text, message] of cases) assert.throws(() => parseSchema(text), error => error instanceof SchemaError && message.test(error.message), text);
});

test('関係も矢印も通らずに自分へ戻る権限は、読んだ時点で誤りとして返す', () => {
  const cases = [
    'definition u {} definition d { relation r: u permission view = edit + r permission edit = view }',
    'definition d { permission p = p }',
    'definition u {} definition d { relation r: u permission p = (q & r) - r permission q = p }',
  ];
  for (const text of cases) assert.throws(() => parseSchema(text), error => error instanceof SchemaError && /refers back to itself/.test(error.message), text);
  assert.doesNotThrow(() => parseSchema('definition u {} definition d { relation r: u relation parent: d permission view = r + parent->view }'), 'through an arrow');
});
