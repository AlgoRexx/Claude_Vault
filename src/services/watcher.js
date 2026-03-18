const chokidar = require('chokidar');
const path = require('path');
const { ingestFile } = require('./ingestion');

function startWatcher(db, config) {
  const watchDir = config.watchDir;
  
  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: config.stabilizationThresholdMs || 2000,
      pollInterval: config.pollIntervalMs || 500
    },
    ignored: [
      /\.crdownload$/,   // Chrome partial downloads
      /\.part$/,         // Firefox partial downloads
      /\.download$/,     // Safari partial downloads
      /(^|[\/\\])\../   // Hidden files
    ]
  });

  watcher.on('add', async (filePath) => {
    console.log(`WATCHER · ADD · ${path.basename(filePath)}`);
    try {
      const result = await ingestFile(db, config, filePath);
      console.log(`WATCHER · ${result.status} · ${path.basename(filePath)} · ${result.fileId || ''}`);
      if (global.mainWindow) {
        global.mainWindow.webContents.send('watcher-update', { type: 'ADD', result, filePath });
      }
    } catch (err) {
      console.error(`WATCHER · ERROR · ${path.basename(filePath)} · ${err.message}`);
    }
  });

  watcher.on('error', (error) => {
    console.error(`WATCHER · ERROR · ${error.message}`);
  });

  console.log(`WATCHER · WATCHING · ${watchDir}`);
  return watcher;
}

module.exports = {
  startWatcher
};
