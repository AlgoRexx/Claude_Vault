const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../../config.json');

function resolveHome(filepath) {
  if (filepath.startsWith('~')) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function loadConfig() {
  let config;
  try {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      config = fs.readJsonSync(DEFAULT_CONFIG_PATH);
    } else {
      const defaultConfig = fs.readJsonSync(path.join(__dirname, '../../default_config.json'));
      fs.writeJsonSync(DEFAULT_CONFIG_PATH, defaultConfig, { spaces: 2 });
      config = defaultConfig;
    }
  } catch (err) {
    console.error(`CONFIG ERROR · FAILED TO LOAD · ${err.message}`);
    process.exit(1);
  }

  // Resolve paths
  config.watchDir = resolveHome(config.watchDir);
  config.projectStore = resolveHome(config.projectStore);
  config.unlinkedStore = resolveHome(config.unlinkedStore);
  config.archiveDir = resolveHome(config.archiveDir);
  config.dbPath = resolveHome(config.dbPath);

  // Validate
  const requiredKeys = ['watchDir', 'projectStore', 'unlinkedStore', 'archiveDir', 'dbPath'];
  for (const key of requiredKeys) {
    if (!config[key]) {
      console.error(`CONFIG ERROR · ${key.toUpperCase()} · MISSING`);
      process.exit(1);
    }
  }

  return config;
}

module.exports = {
  loadConfig,
  resolveHome
};
