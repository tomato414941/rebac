import test from 'node:test';
import assert from 'node:assert/strict';
import { rebac } from '../src/index.mjs';

// A model shaped like Foundation's: principals that hold things, use them through agents, and give single actions
// away; the holder is a relation, the principal itself a relation too, and "the holder alone" one permission.
const SCHEMA = `
  definition credential {}
  definition principal {
    relation self: principal
    relation owner: principal
    relation agent: principal
    relation entry: credential
    permission manage = self + owner
    permission use = self + agent
    permission decide = self
  }
  definition connection {
    relation holder: principal
    relation viewer: principal
    relation disconnector: principal
    permission read = holder->use + viewer
    permission use = holder->use
    permission disconnect = holder->decide + disconnector
    permission share = holder->decide
  }
`;
const p = id => ({ type: 'principal', id });
const c = id => ({ type: 'connection', id });
const rows = tuples => (object, relation) => tuples.filter(([o, r]) => o.type === object.type && o.id === object.id && r === relation).map(([, , s]) => s);

test('持ち主は本人として決め、代わりに動く者は使えるが決められず、1つの操作を渡された者はそれだけできる', async () => {
  const authz = rebac(SCHEMA, rows([
    [p('me'), 'self', p('me')], [p('ai'), 'self', p('ai')],
    [p('ai'), 'owner', p('me')], [p('me'), 'agent', p('ai')],
    [c('gmail'), 'holder', p('me')], [c('gmail'), 'disconnector', p('ai')],
    [c('github'), 'holder', p('me')], [c('github'), 'viewer', p('friend')],
  ]));
  assert.equal(await authz.check(c('gmail'), 'use', p('me')), true);
  assert.equal(await authz.check(c('gmail'), 'use', p('ai')), true, 'the agent uses what its principal holds');
  assert.equal(await authz.check(c('gmail'), 'share', p('ai')), false, 'but does not decide for it');
  assert.equal(await authz.check(c('gmail'), 'disconnect', p('ai')), true, 'except where that one action was given');
  assert.equal(await authz.check(c('github'), 'disconnect', p('ai')), false, 'on that one connection only');
  assert.equal(await authz.check(c('github'), 'read', p('friend')), true);
  assert.equal(await authz.check(c('github'), 'use', p('friend')), false, 'a viewer is not an agent');
  assert.equal(await authz.check(p('ai'), 'manage', p('me')), true, 'the owner manages what it made');
  assert.equal(await authz.check(p('me'), 'manage', p('ai')), false);
});
