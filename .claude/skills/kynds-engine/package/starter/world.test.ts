import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from './world.ts';

test('two people find a stool each by the fire, and a third has none', () => {
  const w = new World(7);
  const a = w.addPerson('a', 'Ada', { x: 1, z: 5 }), b = w.addPerson('b', 'Bran', { x: 7, z: 5 }), c = w.addPerson('c', 'Cuth', { x: 4, z: 5 });
  assert.ok(w.sitByTheFire(a) && w.sitByTheFire(b));
  assert.ok(!w.sitByTheFire(c), 'both stools taken');
  assert.notEqual(a.slot, b.slot);
  for (let i = 0; i < 100; i++) w.step(0.1);
  assert.equal(a.posture, 'sit');
  assert.equal(b.posture, 'sit');
  assert.equal(w.tiers.tierOf('a'), 'full');
});

test('a save round-trips, claims and all', () => {
  const w = new World(3);
  const a = w.addPerson('a', 'Ada', { x: 1, z: 5 });
  w.sitByTheFire(a);
  w.step(1);
  const again = new World(3);
  again.load(w.save());
  assert.equal(again.people.get('a')!.slot, a.slot);
  assert.equal(again.claims.reservedBy(a.slot!), 'a');
});
