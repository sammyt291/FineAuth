import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { logEvent } from './logger.js';

function logModuleEvent(action, details = null) {
  logEvent('module', action, details);
}

export class ModuleManager {
  constructor({
    modulesPath,
    moduleExtractPath,
    io,
    permissionsManager,
    decorateModule
  }) {
    this.modulesPath = modulesPath;
    this.moduleExtractPath = moduleExtractPath;
    this.io = io;
    this.modules = new Map();
    this.accountModifiers = [];
    this.permissionsManager = permissionsManager;
    this.decorateModule = decorateModule;
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
    const modules = Array.from(this.modules.values()).map((moduleData) => ({
      ...moduleData
    }));
    if (this.decorateModule) {
      return modules.map((moduleData) => this.decorateModule(moduleData));
    }
    return modules;
  }

  getModule(name) {
    return this.modules.get(name);
  }

  loadModulesFromDisk() {
    if (!fs.existsSync(this.modulesPath)) {
      fs.mkdirSync(this.modulesPath, { recursive: true });
      return;
    }
    const entries = fs.readdirSync(this.modulesPath, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.isDirectory()) {
        const folderName = entry.name;
        const manifestPath = path.join(this.modulesPath, folderName, 'module.json');
        if (fs.existsSync(manifestPath)) {
          try {
            this.loadModuleFolder(folderName);
          } catch (error) {
            console.warn(`Failed to load module folder ${folderName}: ${error.message}`);
          }
        }
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.zip')) {
        const name = path.basename(entry.name, '.zip');
        try {
          this.loadModuleZip(name);
        } catch (error) {
          console.warn(`Failed to load module zip ${name}: ${error.message}`);
        }
      }
    });
  }

  loadModuleFolder(moduleName) {
    const folderPath = path.join(this.modulesPath, moduleName);
    const manifestPath = path.join(folderPath, 'module.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`module.json missing for ${moduleName}`);
    }
    return this.loadModuleFromManifest({
      manifestPath,
      assetsPath: folderPath,
      source: { type: 'folder', path: folderPath }
    });
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
    return this.loadModuleFromManifest({
      manifestPath,
      assetsPath: extractPath,
      source: { type: 'zip', path: zipPath, extractPath }
    });
  }

  loadModuleFromManifest({ manifestPath, assetsPath, source }) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const moduleData = {
      name: manifest.name ?? path.basename(path.dirname(manifestPath)),
      displayName: manifest.displayName ?? manifest.name ?? '',
      description: manifest.description ?? '',
      mainPage: manifest.mainPage ?? 'index.html',
      assetsPath,
      config: manifest.config ?? {},
      hidden: manifest.hidden ?? false,
      permissions: manifest.permissions ?? [],
      adminSettings: manifest.adminSettings ?? null,
      homePanel: manifest.homePanel ?? null,
      loadedAt: new Date().toISOString(),
      source
    };

    if (Array.isArray(moduleData.permissions) && this.permissionsManager) {
      moduleData.permissions.forEach((permission) => {
        if (typeof permission === 'string') {
          this.permissionsManager.registerPermission(permission);
          return;
        }
        this.permissionsManager.registerPermission(
          permission.name,
          permission.description
        );
      });
    }

    this.modules.set(moduleData.name, moduleData);
    logModuleEvent('Loaded module', {
      name: moduleData.name,
      displayName: moduleData.displayName,
      source: moduleData.source
    });
    this.notifyClients();
    return moduleData;
  }

  loadModule(moduleName) {
    const folderPath = path.join(this.modulesPath, moduleName);
    const zipPath = path.join(this.modulesPath, `${moduleName}.zip`);
    if (fs.existsSync(folderPath)) {
      return this.loadModuleFolder(moduleName);
    }
    if (fs.existsSync(zipPath)) {
      return this.loadModuleZip(moduleName);
    }
    throw new Error(`Module not found: ${moduleName}`);
  }

  unloadModule(moduleName) {
    const moduleData = this.modules.get(moduleName);
    if (!moduleData) {
      throw new Error(`Module not loaded: ${moduleName}`);
    }
    this.modules.delete(moduleName);
    logModuleEvent('Unloaded module', {
      name: moduleData.name,
      source: moduleData.source
    });
    if (moduleData.source?.type === 'zip') {
      const extractPath =
        moduleData.source.extractPath ??
        path.join(this.moduleExtractPath, moduleName);
      if (fs.existsSync(extractPath)) {
        fs.rmSync(extractPath, { recursive: true, force: true });
      }
    }
    this.notifyClients();
  }

  reloadModule(moduleName) {
    this.unloadModule(moduleName);
    logModuleEvent('Reloading module', { name: moduleName });
    return this.loadModule(moduleName);
  }

  notifyClients() {
    if (this.io) {
      this.io.emit('modules:update', this.listModules());
    }
  }
}
