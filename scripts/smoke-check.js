const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const jsFiles = fs.readdirSync(srcDir).filter((name) => name.endsWith('.js'));

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(srcDir, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const { DashboardCommandCenter } = require(path.join(srcDir, 'dashboard-command-center.js'));
const commandCenter = new DashboardCommandCenter({ projectRoot: root });
const presets = commandCenter.listPresets();
if (!Array.isArray(presets) || presets.length < 4) {
  throw new Error('Preset command catalog tidak terbaca dengan benar.');
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
if (!readme.includes('Context Bridge')) {
  throw new Error('README belum terbarui dengan branding baru.');
}

console.log(`Smoke check passed. ${jsFiles.length} source files parsed, ${presets.length} presets loaded.`);
