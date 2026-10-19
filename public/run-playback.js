export function durationLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Capture an original observation, never interpolated map coordinates. Invisibility
// intervals have no known position and must not create a tracking correction.
export function replayTrackerSample(recording, uuid, time) {
  if (!recording || !uuid || !Number.isFinite(time)) return null;
  const participant = recording.participants.find(p => p.uuid === uuid);
  if (!participant) return null;
  const samples = recording.samples.filter(s => s.uuid === uuid);
  if (!replayPosition(samples, time)) return null;
  const sample = samples.findLast(s => s.time <= time);
  if (!sample || typeof sample.world !== 'string' || !sample.world || !['x', 'y', 'z'].every(axis => Number.isFinite(sample[axis]))) return null;
  return { ...sample, name: participant.name };
}

export function indexRecording(recording, manifest) {
  const sections = manifest && new Map(manifest.floors.flatMap(f => f.sections.map(s => [s.id, { ...s, floorId: f.id, floorName: f.name }])));
  return new Map(recording.participants.map(p => [p.uuid, recording.samples.filter(s => s.uuid === p.uuid).map(sample => {
    if (!sections) return sample;
    const section = sections.get(sample.sectionId);
    return section ? { ...sample, floorId: section.floorId, floorName: section.floorName, sectionName: section.name, display: { x: section.placementX + sample.local.x, z: section.placementZ + sample.local.z } } : { ...sample, unavailable: true };
  })]));
}

export function replayPosition(samples, time) {
  if (!samples?.length || time < samples[0].time || time > samples.at(-1).time) return null;
  let low = 0, high = samples.length;
  while (low < high) { const mid = (low + high) >>> 1; if (samples[mid].time <= time) low = mid + 1; else high = mid; }
  const a = samples[low - 1], b = samples[low];
  if (a.unavailable) return null;
  if (!b || time === a.time) return a;
  if (b.unavailable) return a;
  if (b.invisibility) return null;
  if (a.floorId !== b.floorId) return { ...a, transition: { floorId: b.floorId, floorName: b.floorName, sectionName: b.sectionName } };
  const t = (time - a.time) / (b.time - a.time);
  // Interpolate in floor coordinates: separate sections have independent local origins.
  if (a.display && b.display) return { ...a, display: { x: a.display.x + (b.display.x - a.display.x) * t, z: a.display.z + (b.display.z - a.display.z) * t } };
  if (a.sectionId !== b.sectionId) return a;
  return { ...a, local: { x: a.local.x + (b.local.x - a.local.x) * t, z: a.local.z + (b.local.z - a.local.z) * t } };
}

export function routeSegments(samples, sectionIds) {
  const segments = []; let current = null, previous;
  for (const sample of samples) {
    if (sample.unavailable || !sectionIds.has(sample.sectionId)) { current = null; previous = sample; continue; }
    if (!current || sample.invisibility || previous?.floorId !== sample.floorId) { current = []; segments.push(current); }
    current.push(sample); previous = sample;
  }
  return segments;
}

export function routeAnnotations(samples, status) {
  const annotations = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1], to = samples[i];
    if (to.invisibility) {
      if (!from.unavailable) annotations.push({ kind: 'invisibility-start', sample: from, destination: to.unavailable ? null : to, durationMs: to.invisibility.durationMs });
      if (!to.unavailable) annotations.push({ kind: 'invisibility-end', sample: to, destination: from.unavailable ? null : from, durationMs: to.invisibility.durationMs });
    }
    if (!to.invisibility && !from.unavailable && !to.unavailable && from.floorId !== to.floorId) annotations.push({ kind: 'exit', sample: from, destination: to });
  }
  const last = samples.at(-1);
  if (status === 'loss' && last && !last.unavailable) annotations.push({ kind: 'loss', sample: last });
  return annotations;
}
