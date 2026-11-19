import { app, nativeImage } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Product composition uses the reviewed Harness Desktop fork.
// Keep the existing profile and single-instance boundary across the rename.
const userData = resolve(app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'YouDub2bi'));
app.setName('You2Bi');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
if (process.platform === 'win32') app.setAppUserModelId('com.youdub2bi.desktop');
if (app.isPackaged) {
  // Installed builds own their runtime; Finder and Explorer supply no development paths.
  const runtime = app.getAppPath();
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('DSH_')) delete process.env[name];
  }
  process.env.YOUDUB_DESKTOP_RUNTIME_DIR = runtime;
  process.env.YOUDUB_DESKTOP_PNPM_ENTRY = join(runtime, 'node_modules/pnpm/bin/pnpm.mjs');
  process.env.YOUDUB_HARNESS_PLUGIN_ROOT = join(runtime, 'node_modules/@youdub/harness-subtitles');
  process.env.YOUDUB_MEDIA_ROOT = join(process.resourcesPath, 'youdub');
  process.env.YOUDUB_NODE_PATH = process.execPath;
  // Python imports must not write bytecode into the signed application bundle.
  process.env.PYTHONDONTWRITEBYTECODE = '1';
}
// Assign after clearing inherited keys: Windows environment names ignore case.
// Keep the existing YouDub home for upgrades, never Harness's home.
process.env.YOUDUB_HOME = resolve(process.env.YOU2BI_HOME || process.env.YOUDUB2BI_HOME || process.env.YOUDUB_HOME || join(app.getPath('userData'), 'harness'));
process.env.DSH_HOME = process.env.YOUDUB_HOME;
const iconPath = join(app.getAppPath(), 'resources/you2bi-icon.png');
const icon = nativeImage.createFromPath(iconPath);
if (icon.isEmpty()) throw new Error(`Cannot load You2Bi application icon: ${iconPath}`);
void app.whenReady().then(() => app.dock?.setIcon(icon));
app.on('browser-window-created', (_event, window) => {
  if (process.platform !== 'darwin') window.setIcon(icon);
});
await import('./lib/youdub-main.js');
