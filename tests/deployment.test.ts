import { describe, expect, it } from 'vitest';
import { productionOrigin } from '../scripts/site-origin';

describe('production origin', () => {
  it('normalizes an HTTPS public origin', () => {
    expect(productionOrigin('https://steadyfolio.workers.dev/')).toBe('https://steadyfolio.workers.dev');
  });
  it('rejects placeholders, credentials, queries, paths and local endpoints', () => {
    for (const value of [undefined,'https://your-domain.example','https://example.com','https://fake.invalid','http://real.com','https://127.0.0.1','https://[::1]','https://localhost','https://user:pass@real.com','https://real.com/repo/','https://real.com/?secret=x','https://real.com/#x','https://real.com:5173']) expect(productionOrigin(value)).toBeNull();
  });
});
