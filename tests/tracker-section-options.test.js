import test from 'node:test';
import assert from 'node:assert/strict';
import { trackerSectionOptions } from '../public/tracker-points.js';

test('capture lists uncalibrated Mansion with its reason, and allows it after calibration', () => {
  const sections = [
    { id: 'lower', name: 'Mansion', floorName: '-2F', calibration: { world: 'world' } },
    { id: 'upper', name: 'Mansion', floorName: '-1F', calibration: null }
  ];
  const options = trackerSectionOptions(sections, 'world');
  assert.equal(options.length, 2, 'Mansion must not disappear because it lacks a waypoint');
  assert.equal(options[1].reason, 'Needs waypoint');
  assert.match(options[1].label, /-1F.*Mansion.*Needs waypoint/);
  sections[1].calibration = { world: 'world' };
  assert.equal(trackerSectionOptions(sections, 'world')[1].reason, '');
});

test('capture explains world mismatches and invalid waypoints, while replacement stays in its section', () => {
  const sections = [
    { id: 'other', name: 'Other', floorName: '1F', calibration: { world: 'nether' } },
    { id: 'invalid', name: 'Invalid', floorName: '1F', calibration: { world: 'world', invalidReason: 'Replace the reference block.' } }
  ];
  assert.match(trackerSectionOptions(sections, 'world')[0].reason, /nether/);
  assert.match(trackerSectionOptions(sections, 'world')[1].reason, /Replace the reference block/);
  assert.deepEqual(trackerSectionOptions(sections, 'world', 'invalid').map(s => s.id), ['invalid']);
});
