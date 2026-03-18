const { loadConfig } = require('./utils/config');
const { initDb } = require('./database/db');
const { startWatcher } = require('./services/watcher');
const chalk = require('chalk');

const config = loadConfig();
const db = initDb(config.dbPath);

console.log(chalk.hex('#FF4B35').bold('CLAUDE VAULT SERVICE STARTING...'));
console.log(`↳ WATCH DIR: ${config.watchDir}`);
console.log(`↳ DB PATH:  ${config.dbPath}`);

const watcher = startWatcher(db, config);

process.on('SIGINT', () => {
  console.log(`\n${chalk.hex('#FF4B35').bold('SHUTTING DOWN...')}`);
  watcher.close();
  db.close();
  process.exit();
});

// Keep process alive
process.stdin.resume();
