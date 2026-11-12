'use strict';
const knex = require('knex');
const path = require('path');

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: '/app/dist/database/migrations',
    extension: 'js',
    tableName: 'knex_migrations',
    loadExtensions: ['.js']
  }
});

db.migrate.latest()
  .then(([batch, log]) => {
    if (log.length === 0) {
      console.log('All migrations already up to date.');
    } else {
      console.log('Migrations complete. Batch:', batch);
      log.forEach(f => console.log('  ->', f));
    }
    return db.seed.run({ directory: '/app/dist/database/seeds', loadExtensions: ['.js'] }).catch(() => {});
  })
  .then(() => { console.log('Seeds done (or skipped).'); return db.destroy(); })  .catch(err => {
    console.error('Migration error:', err.message);
    process.exit(1);
  });
