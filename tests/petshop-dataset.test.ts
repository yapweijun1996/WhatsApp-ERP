import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { DemoErpAdapter } from '../src/erp.js';

test('petshop is opt-in and seeds a fictional public catalog', async () => {
  const db = new V1Database(':memory:', undefined, undefined, 'petshop');
  db.resetAndSeed();
  assert.equal((db.db.prepare('SELECT name FROM customers WHERE id=?').get('CUST-001') as any).name, 'Happy Paws Pet Cafe Sdn Bhd');
  const matches = await new DemoErpAdapter(db.db).searchPublicCatalog('litter box', 5);
  assert.ok(matches.some(x => x.output.stockCode === 'LITTER-AUTO-01'));
  assert.equal((db.db.prepare('SELECT count(*) n FROM company_profile WHERE is_demo=1').get() as any).n, 1);
  db.db.close();
});

test('default seed remains the existing chicken dataset with a neutral profile', () => {
  const db = new V1Database(':memory:', undefined, undefined, 'default');
  db.resetAndSeed();
  assert.equal((db.db.prepare('SELECT name FROM customers WHERE id=?').get('CUST-001') as any).name, 'Sunrise Mini Mart Pte Ltd');
  assert.equal((db.db.prepare('SELECT count(*) n FROM products').get() as any).n, 3);
  db.db.close();
});
