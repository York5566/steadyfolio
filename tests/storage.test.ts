import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function database() {const db = new DatabaseSync(':memory:'); db.exec(readFileSync('migrations/0001_initial.sql','utf8')); return db;}
function insert(db: DatabaseSync, id: string, bytes: number, daily = 30, capacity = 10000) {
  return db.prepare(`INSERT INTO shares(id,payload,delete_hash,created_at,expires_at,size_bytes)
    SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT count FROM share_budget WHERE day = ?),0) < ?
    AND (SELECT bytes FROM storage_budget WHERE id = 1) + ? <= ?`)
    .run(id,'{}','hash',1792195200,1794787200,bytes,'2026-10-17',daily,bytes,capacity);
}
describe('atomic D1-compatible storage rules', () => {
  it('enforces daily share and cumulative byte budgets in the insert statement', () => {
    const db = database();
    expect(insert(db,'first',600,2,1000).changes).toBe(1);
    expect(insert(db,'too-big',600,2,1000).changes).toBe(0);
    expect(insert(db,'second',300,2,1000).changes).toBe(1);
    expect(insert(db,'third',10,2,1000).changes).toBe(0);
    expect(db.prepare('SELECT bytes FROM storage_budget').get()?.bytes).toBe(900);
    db.close();
  });
  it('releases capacity on deletion without resetting the daily abuse budget', () => {
    const db = database();insert(db,'first',600,1,1000);
    db.prepare('DELETE FROM shares WHERE id = ?').run('first');
    expect(db.prepare('SELECT bytes FROM storage_budget').get()?.bytes).toBe(0);
    expect(insert(db,'second',100,1,1000).changes).toBe(0);
    db.close();
  });
  it('retains bounded expiration cleanup and indexed primary-key reads', () => {
    const db = database();insert(db,'one',100);insert(db,'two',100);
    db.prepare('DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE expires_at <= ? ORDER BY expires_at LIMIT 1)').run(9999999999);
    expect(db.prepare('SELECT COUNT(*) AS total FROM shares').get()?.total).toBe(1);
    const plan = JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM shares WHERE id = ?').all('one'));
    expect(plan).toContain('INDEX');db.close();
  });
});
