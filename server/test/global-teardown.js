'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const STATE_FILE = path.join(os.tmpdir(), 'cert-platform-e2e-pg.json');

module.exports = async function globalTeardown() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const pg = new EmbeddedPostgres({
      databaseDir: state.databaseDir,
      user: state.user,
      password: state.password,
      port: state.port,
      persistent: false,
    });
    await pg.stop();
  } catch (e) {
    // already stopped / never started
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch (_) {}
};
