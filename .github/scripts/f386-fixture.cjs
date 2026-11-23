const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const schema = 'CREATE TABLE synthetic (id INTEGER PRIMARY KEY, value TEXT NOT NULL)';
const expected = { schema, rows: [[1, 'synthetic-alpha'], [2, 'synthetic-beta']] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const logicalDigest = value => digest(JSON.stringify(value));

function inspect(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    assert.deepEqual(integrity, ['ok']);
    const tables = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.equal(tables.length, 1);
    const rows = db.prepare('SELECT id, value FROM synthetic ORDER BY id').all().map(({ id, value }) => [id, value]);
    const actual = { schema: tables[0].sql, rows };
    assert.deepEqual(actual, expected);
    return { integrity: 'ok', schema: actual.schema, rows: rows.length, logicalSha256: logicalDigest(actual) };
  } finally {
    db.close();
  }
}

const [mode, folder, restore, expectedManifest] = process.argv.slice(2);
assert(folder, 'A staging directory is required');
assert(/^(?:[1-9][0-9]*\.[1-9][0-9]*|local)$/.test(process.env.F386_RUN ?? ''), 'Invalid run identifier');
const run = process.env.F386_RUN;
const dbPath = path.join(folder, 'fixture.db');
const manifestPath = path.join(folder, 'manifest.json');

if (mode === 'create') {
  fs.mkdirSync(folder);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=DELETE; " + schema + "; INSERT INTO synthetic VALUES (1, 'synthetic-alpha'), (2, 'synthetic-beta');");
  } finally {
    db.close();
  }
  const manifest = { version: 1, run, fixture: 'fixture.db', bytes: fs.statSync(dbPath).size,
    fileSha256: digest(fs.readFileSync(dbPath)), ...inspect(dbPath) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const manifestSha256 = digest(fs.readFileSync(manifestPath));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'manifest_sha256=' + manifestSha256 + '\n');
  console.log(JSON.stringify({ ...manifest, manifestSha256 }));
} else {
  assert.equal(mode, 'verify');
  assert(restore && /^[0-9a-f]{64}$/.test(expectedManifest), 'A fresh restore directory and source manifest hash are required');
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  assert(entries.every(entry => entry.isFile() && !entry.isSymbolicLink()), 'Expected ordinary files only');
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['fixture.db', 'manifest.json']);
  const manifestBytes = fs.readFileSync(manifestPath);
  assert.equal(digest(manifestBytes), expectedManifest, 'Manifest SHA-256 mismatch');
  const manifest = JSON.parse(manifestBytes);
  const dbBytes = fs.readFileSync(dbPath);
  assert.equal(digest(dbBytes), manifest.fileSha256, 'Fixture SHA-256 mismatch');
  fs.mkdirSync(restore);
  const restored = path.join(restore, 'fixture.db');
  fs.writeFileSync(restored, dbBytes, { flag: 'wx' });
  const actual = { version: 1, run, fixture: 'fixture.db', bytes: dbBytes.length,
    fileSha256: digest(dbBytes), ...inspect(restored) };
  assert.deepEqual(actual, manifest);
  console.log(JSON.stringify({ ...actual, manifestSha256: expectedManifest }));
}
