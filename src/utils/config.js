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
  const requiredKeys = ['watchDir', 'projectStore', 'unlinkedStore', 'archiveDir', 'dbPath', 'limitWindowsMs'];
  for (const key of requiredKeys) {
    if (!config[key]) {
      console.error(`CONFIG ERROR · ${key.toUpperCase()} · MISSING`);
      process.exit(1);
    }
  }

  // Validate account limit windows shape
  const requiredLimitTypes = ['5HR', 'DAILY', 'WEEKLY'];
  if (typeof config.limitWindowsMs !== 'object' || Array.isArray(config.limitWindowsMs)) {
    console.error('CONFIG ERROR · LIMITWINDOWSMS · MUST_BE_OBJECT');
    process.exit(1);
  }
  for (const lt of requiredLimitTypes) {
    const v = config.limitWindowsMs[lt];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      console.error(`CONFIG ERROR · LIMITWINDOWSMS.${lt} · INVALID`);
      process.exit(1);
    }
  }

  return config;
}

module.exports = {
  loadConfig,
  resolveHome
};
