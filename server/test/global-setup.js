'use strict';
/**
 * Boot one real (embedded) PostgreSQL for the whole e2e run and publish its
 * coordinates via a state file that test workers read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const STATE_FILE = path.join(os.tmpdir(), 'cert-platform-e2e-pg.json');
const PORT = 55444;

module.exports = async function globalSetup() {
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-e2e-'));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ databaseDir, port: PORT, user: 'postgres', password: 'postgres' }),
  );
};
