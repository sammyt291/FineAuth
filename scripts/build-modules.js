import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const modulesDir = path.join(rootDir, 'modules');

if (!fs.existsSync(modulesDir)) {
  console.error(`Modules directory not found: ${modulesDir}`);
  process.exit(1);
}

const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
const moduleFolders = entries.filter((entry) => entry.isDirectory());

moduleFolders.forEach((entry) => {
  const moduleName = entry.name;
  const modulePath = path.join(modulesDir, moduleName);
  const manifestPath = path.join(modulePath, 'module.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`Skipping ${moduleName}: module.json not found.`);
    return;
  }
  const zipPath = path.join(modulesDir, `${moduleName}.zip`);
  const zip = new AdmZip();
  zip.addLocalFile(manifestPath);
  zip.writeZip(zipPath);
  console.log(`Built ${zipPath}`);
});
