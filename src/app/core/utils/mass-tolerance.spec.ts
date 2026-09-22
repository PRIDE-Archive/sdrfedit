import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeMassTolerance, isValidMassTolerance } from './mass-tolerance.ts';

describe('SDRF mass tolerances', () => {
  it('preserves decimal precision and normalizes supported units', () => {
    assert.equal(normalizeMassTolerance(' 0.02 da '), '0.02 Da');
    assert.equal(normalizeMassTolerance('10ppm'), '10 ppm');
    assert.equal(normalizeMassTolerance('.5 MMU'), '0.5 mmu');
  });
  it('allows omission and explicit unknown values', () => {
    assert.equal(normalizeMassTolerance('  '), '');
    assert.equal(normalizeMassTolerance('Not Available'), 'not available');
  });
  it('rejects invalid AI arguments and incorrectly specified tolerances', () => {
    for (const value of [null, undefined, 10, {}, '10', '-5 ppm', '0 Da', 'NaN ppm', 'Infinity Da', '20 %', '10 ppm junk']) {
      assert.equal(isValidMassTolerance(value), false, JSON.stringify(value));
      assert.throws(() => normalizeMassTolerance(value));
    }
  });
});
