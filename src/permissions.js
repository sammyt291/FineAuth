import fs from 'fs';
import path from 'path';

const DEFAULT_PERMISSIONS = {
  permissions: {}
};

export class PermissionsManager {
  constructor({ permissionsPath }) {
    this.permissionsPath = permissionsPath;
    this.permissions = {};
    this.ensurePermissionsFile();
  }

  ensurePermissionsFile() {
    const dir = path.dirname(this.permissionsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.permissionsPath)) {
      fs.writeFileSync(
        this.permissionsPath,
        JSON.stringify(DEFAULT_PERMISSIONS, null, 2)
      );
    }
    this.load();
  }

  load() {
    const raw = fs.readFileSync(this.permissionsPath, 'utf-8');
    const data = JSON.parse(raw);
    this.permissions = data.permissions ?? {};
  }

  save() {
    fs.writeFileSync(
      this.permissionsPath,
      JSON.stringify({ permissions: this.permissions }, null, 2)
    );
  }

  registerPermission(name, description = '') {
    if (!name) {
      return;
    }
    const existing = this.permissions[name];
    if (!existing) {
      this.permissions[name] = {
        description,
        accounts: []
      };
      this.save();
      return;
    }
    if (description && existing.description !== description) {
      existing.description = description;
      this.save();
    }
  }

  setAccountPermission(permissionName, accountName, enabled) {
    if (!permissionName || !accountName) {
      return;
    }
    const entry = this.permissions[permissionName];
    if (!entry) {
      this.permissions[permissionName] = {
        description: '',
        accounts: []
      };
    }
    const accounts = this.permissions[permissionName].accounts;
    const hasAccount = accounts.includes(accountName);
    if (enabled && !hasAccount) {
      accounts.push(accountName);
      this.save();
    }
    if (!enabled && hasAccount) {
      this.permissions[permissionName].accounts = accounts.filter(
        (name) => name !== accountName
      );
      this.save();
    }
  }

  isAdmin(accountName) {
    if (!accountName) {
      return false;
    }
    const adminPermission = this.permissions.admin;
    return adminPermission?.accounts?.includes(accountName) ?? false;
  }

  hasPermission(accountName, permissionName) {
    if (!permissionName) {
      return false;
    }
    if (this.isAdmin(accountName)) {
      return true;
    }
    const entry = this.permissions[permissionName];
    return entry?.accounts?.includes(accountName) ?? false;
  }

  listPermissions() {
    return Object.entries(this.permissions).map(([name, data]) => ({
      name,
      description: data.description ?? '',
      accounts: [...(data.accounts ?? [])]
    }));
  }
}
