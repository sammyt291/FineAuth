# FineAuth

FineAuth is a Node.js Eve Online authentication site with a modular front-end and server-side SQLite storage. It supports optional HTTPS, hot-restarts when SSL cert files rotate, and user-made modules packaged as ZIP files in `/modules`.

## Features
- Landing page with glowing animated title, admin login, and ESI main-character sign-in.
- Home dashboard with UI helpers, socket.io connection status, current account, and ESI queue display.
- Navigation module with top menu and dropdown previews for loaded modules.
- Module loader for ZIP packages with live load/unload/reload commands.
- SQLite-backed account storage with hashed tokens, character lists, and per-module account data.
- Auto-refresh/validation timers for ESI token refresh and character name checks.

## Quick start
```bash
npm install
npm start
```

Open `http://localhost:3000` (or HTTPS if enabled in config).

## Configuration
Edit `config/config.json`:
- `port`: Server port.
- `https.enabled`: Toggle HTTPS.
- `https.keyPath` / `https.certPath`: Paths to SSL cert files.
- `modulesPath`: Folder containing module ZIPs.
- `moduleExtractPath`: Extraction target for loaded modules.
- `adminAuth`: Admin login credentials.
- `esi.refreshIntervalMinutes`: Refresh cadence for ESI tokens.
- `esi.characterNameCheckMinutes`: Verify character names at this interval.

When HTTPS is enabled, the server watches `keyPath` and `certPath` and restarts automatically when the files change (useful for Let's Encrypt renewals).

## Modules
### Built-in modules
- **Landing / Login**: Centered login panel with animated FineAuth title.
- **Home**: Dashboard with helper grid, tooltips, socket status, and ESI queue.
- **Navigation**: Demonstrates top nav and dropdown behavior.

### User modules (ZIP)
Place module ZIP files in `/modules` with a `module.json` manifest. Example:
```json
{
  "name": "example",
  "displayName": "Example Module",
  "description": "My custom module",
  "mainPage": "index.html",
  "config": {
    "optionA": true
  }
}
```

The ZIP is extracted to `/modules_loaded/<moduleName>` and served at `/modules/<moduleName>/`.

### Load/unload modules at runtime
Type into the server console:
```
load example
reload example
unload example
```

Clients are notified via socket.io and redirected to the home page if their current module was unloaded.

## Module account data
Modules can store account-specific data by POSTing to:
```
POST /api/modules/:name/account-data
Authorization: Bearer <token>
```

Data is saved in SQLite and linked to the authenticated account.

## Notes on ESI
This starter app includes placeholder endpoints for ESI login and token refresh scheduling. Wire your ESI OAuth flow and token refresh calls into the `/api/login/esi` handler and the `scheduleEsiRefresh()` interval in `src/server.js`.
