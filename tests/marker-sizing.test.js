import test from 'node:test';
import assert from 'node:assert/strict';
import { markerScale } from '../public/marker-sizing.js';

test('markers remain within screen-size limits at manual and fit zoom levels', () => {
  for (const minimum of [16, 24, 40]) {
    for (const zoom of [.01, .05, .15, .5, 1, 1.5, 4, 12]) {
      const screenSize = 28 * zoom * markerScale(zoom, minimum);
      assert.ok(screenSize >= minimum - 1e-9);
      assert.ok(screenSize <= 48 + 1e-9);
    }
  }
  assert.equal(markerScale(1, 24), 1);
  assert.equal(28 * .1 * markerScale(.1), 24);
  assert.equal(28 * 12 * markerScale(12), 48);
  assert.ok(Number.isFinite(markerScale(0, NaN)));
});
