import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

export class ModuleManager {
  constructor({ modulesPath, moduleExtractPath, io }) {
    this.modulesPath = modulesPath;
    this.moduleExtractPath = moduleExtractPath;
    this.io = io;
    this.modules = new Map();
    this.accountModifiers = [];
    this.ensureExtractPath();
  }

  ensureExtractPath() {
    if (!fs.existsSync(this.moduleExtractPath)) {
      fs.mkdirSync(this.moduleExtractPath, { recursive: true });
    }
  }

  registerAccountModifier(modifier) {
    if (typeof modifier === 'function') {
      this.accountModifiers.push(modifier);
    }
  }

  getAccountModifiers() {
    return [...this.accountModifiers];
  }

  listModules() {
    return Array.from(this.modules.values());
  }

  getModule(name) {
    return this.modules.get(name);
  }

  async loadBuiltInModules(builtInModules) {
    builtInModules.forEach((module) => {
      this.modules.set(module.name, {
        ...module,
        builtIn: true,
        loadedAt: new Date().toISOString()
      });
    });
    this.notifyClients();
  }

  loadModuleZip(moduleName) {
    const zipPath = path.join(this.modulesPath, `${moduleName}.zip`);
    if (!fs.existsSync(zipPath)) {
      throw new Error(`Module zip not found: ${zipPath}`);
    }

    const zip = new AdmZip(zipPath);
    const extractPath = path.join(this.moduleExtractPath, moduleName);
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    fs.mkdirSync(extractPath, { recursive: true });
    zip.extractAllTo(extractPath, true);

    const manifestPath = path.join(extractPath, 'module.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`module.json missing for ${moduleName}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const moduleData = {
      name: manifest.name ?? moduleName,
      displayName: manifest.displayName ?? moduleName,
      description: manifest.description ?? '',
      mainPage: manifest.mainPage ?? 'index.html',
      assetsPath: extractPath,
      config: manifest.config ?? {},
      builtIn: false,
      loadedAt: new Date().toISOString()
    };

    this.modules.set(moduleData.name, moduleData);
    this.notifyClients();
    return moduleData;
  }

  unloadModule(moduleName) {
    const moduleData = this.modules.get(moduleName);
    if (!moduleData) {
      throw new Error(`Module not loaded: ${moduleName}`);
    }
    if (moduleData.builtIn) {
      throw new Error(`Cannot unload built-in module: ${moduleName}`);
    }
    this.modules.delete(moduleName);
    const extractPath = path.join(this.moduleExtractPath, moduleName);
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    this.notifyClients();
  }

  reloadModule(moduleName) {
    this.unloadModule(moduleName);
    return this.loadModuleZip(moduleName);
  }

  notifyClients() {
    if (this.io) {
      this.io.emit('modules:update', this.listModules());
    }
  }
}
