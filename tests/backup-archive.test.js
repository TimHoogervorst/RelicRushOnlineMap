import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, readArchive, makeManifest, validateManifest } from '../src/backup-archive.js';

test('backup archive round trips files and rejects unsafe paths and changed bytes', () => {
  const files = new Map([['project.sqlite', Buffer.from('db')], ['assets/a.png', Buffer.from([1, 2, 3])]]);
  const manifest = makeManifest(files);
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const archive = createArchive(files);
  const decoded = readArchive(archive);
  assert.equal(decoded.get('project.sqlite').toString(), 'db');
  assert.equal(validateManifest(decoded).entries.length, 2);
  assert.throws(() => readArchive(createArchive(new Map([['../escape', Buffer.from('x')]]))), /unsafe/i);
  decoded.set('assets/a.png', Buffer.from('bad'));
  assert.throws(() => validateManifest(decoded), /checksum/i);
});
