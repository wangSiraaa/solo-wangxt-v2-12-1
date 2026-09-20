'use strict';
/**
 * Start a persistent embedded PostgreSQL for local development on port 5433.
 * Data lives in server/.pgdata. Safe to run repeatedly.
 */
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

async function main() {
  const databaseDir = path.join(__dirname, '..', '.pgdata');
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: 5433,
    persistent: true,
  });
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    console.log('[db] initialising PostgreSQL cluster...');
    await pg.initialise();
  }
  await pg.start();
  console.log('[db] PostgreSQL ready at postgres://postgres:postgres@127.0.0.1:5433/postgres');
  console.log('[db] press Ctrl+C to stop');
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
