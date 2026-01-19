import fs from 'fs';
import path from 'path';

const DEFAULT_SETTINGS = {
  modules: {}
};

function getDefaultsForModule(moduleData) {
  const fields = moduleData?.adminSettings?.fields ?? [];
  return fields.reduce((accumulator, field) => {
    if (field?.id && field.default !== undefined) {
      accumulator[field.id] = field.default;
    }
    return accumulator;
  }, {});
}

export class ModuleSettingsManager {
  constructor({ settingsPath }) {
    this.settingsPath = settingsPath;
    this.settings = {};
    this.ensureSettingsFile();
  }

  ensureSettingsFile() {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.settingsPath)) {
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify(DEFAULT_SETTINGS, null, 2)
      );
    }
    this.load();
  }

  load() {
    const raw = fs.readFileSync(this.settingsPath, 'utf-8');
    const data = JSON.parse(raw);
    this.settings = data.modules ?? {};
  }

  save() {
    fs.writeFileSync(
      this.settingsPath,
      JSON.stringify({ modules: this.settings }, null, 2)
    );
  }

  getModuleSettings(moduleData) {
    if (!moduleData?.name) {
      return {};
    }
    const defaults = getDefaultsForModule(moduleData);
    const stored = this.settings[moduleData.name] ?? {};
    const merged = { ...defaults, ...stored };
    if (Object.keys(defaults).length) {
      const hasMissing = Object.keys(defaults).some(
        (key) => stored[key] === undefined
      );
      if (hasMissing) {
        this.settings[moduleData.name] = merged;
        this.save();
      }
    }
    return merged;
  }

  updateModuleSettings(moduleData, settings) {
    if (!moduleData?.name) {
      return;
    }
    const defaults = getDefaultsForModule(moduleData);
    const next = { ...defaults, ...settings };
    this.settings[moduleData.name] = next;
    this.save();
  }
}
