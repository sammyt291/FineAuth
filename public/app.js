const mainContent = document.getElementById('main-content');
const nav = document.getElementById('top-nav');
const footer = document.getElementById('footer');

const state = {
  modules: [],
  account: null,
  esiQueue: [],
  esiQueueMeta: {
    queueRunSeconds: 12,
    updatedAt: null
  },
  socketConnected: false,
  loginError: null,
  esiStatus: null,
  charactersError: null,
  charactersRefreshing: false,
  settingsModal: null,
  admin: {
    accounts: [],
    selectedAccountId: null,
    settings: null,
    expandedFeatures: new Set(),
    expandedSettingGroups: new Set(),
    settingsOpen: false,
    loadingAccounts: false,
    loadingSettings: false,
    loadingData: false,
    data: null,
    dataError: null,
    lastDataRequestAt: {},
    mailPage: 1,
    mailSelectedId: null,
    mail: {
      labelsByCharacter: {},
      labelsLoading: new Set(),
      labelsError: {},
      selectedLabelByCharacter: {},
      mailHeadersByLabel: {},
      mailHeadersLoading: new Set(),
      mailHeadersError: {},
      mailDetailCache: {},
      mailDetailLoading: new Set()
    }
  }
};

let socket;
let queueTickerId;

const helpers = {
  createGridContainer(items) {
    const grid = document.createElement('div');
    grid.className = 'helper-grid';
    items.forEach((item) => grid.appendChild(item));
    return grid;
  },
  createBox({ title, body, tooltip }) {
    const box = document.createElement('div');
    box.className = 'helper-box';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = body;
    box.appendChild(heading);
    box.appendChild(text);
    if (tooltip) {
      const tip = document.createElement('div');
      tip.className = 'tooltip';
      tip.textContent = tooltip;
      box.appendChild(tip);
    }
    box.addEventListener('mousemove', (event) => {
      const tip = box.querySelector('.tooltip');
      if (tip) {
        tip.style.left = `${event.offsetX}px`;
        tip.style.top = `${event.offsetY}px`;
      }
    });
    return box;
  },
  applyContentOrder(container, order) {
    const items = Array.from(container.children);
    items.sort((a, b) => order.indexOf(a.dataset.order) - order.indexOf(b.dataset.order));
    items.forEach((item) => container.appendChild(item));
  },
  formatDuration(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  },
  getModule(moduleName) {
    return state.modules.find((module) => module.name === moduleName) ?? null;
  },
  getEsiStatusLabel(status) {
    if (status?.status === 'online') {
      return 'Online';
    }
    if (status?.status === 'unavailable') {
      return 'Unavailable';
    }
    return 'Unknown';
  }
};

const durationUnits = [
  { key: 'mo', label: 'mo', seconds: 30 * 24 * 60 * 60 },
  { key: 'w', label: 'w', seconds: 7 * 24 * 60 * 60 },
  { key: 'd', label: 'd', seconds: 24 * 60 * 60 },
  { key: 'h', label: 'h', seconds: 60 * 60 },
  { key: 'm', label: 'm', seconds: 60 },
  { key: 's', label: 's', seconds: 1 }
];

function parseDurationInput(value) {
  const input = String(value ?? '').toLowerCase();
  const regex = /(\d+)\s*(mo|w|d|h|m|s)/g;
  const seen = new Set();
  const parts = {};
  let totalSeconds = 0;
  let match = regex.exec(input);
  while (match) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    if (!Number.isNaN(amount) && !seen.has(unit)) {
      const unitDef = durationUnits.find((entry) => entry.key === unit);
      if (unitDef) {
        parts[unit] = amount;
        totalSeconds += amount * unitDef.seconds;
        seen.add(unit);
      }
    }
    match = regex.exec(input);
  }
  return { totalSeconds, parts };
}

function formatDurationParts(parts) {
  const labels = durationUnits
    .map((unit) => {
      const amount = parts[unit.key];
      return amount ? `${amount}${unit.label}` : null;
    })
    .filter(Boolean);
  return labels.length ? labels.join(' ') : '0s';
}

function getDurationSummary(value) {
  const parsed = parseDurationInput(value);
  const partsLabel = formatDurationParts(parsed.parts);
  return `Detected total: ${partsLabel}`;
}

function getDefaultModule() {
  if (!state.account) {
    return 'landing';
  }
  return 'home';
}

function getUserEsiTasks() {
  if (!state.account) {
    return [];
  }
  return state.esiQueue.filter((task) => task.accountName === state.account.name);
}

function getEsiQueuePosition(taskId) {
  const index = state.esiQueue.findIndex((task) => task.id === taskId);
  return index === -1 ? null : index + 1;
}

function getHomeLayout() {
  const homeModule = helpers.getModule('home');
  return homeModule?.settings?.panelLayout ?? 'vertical';
}

function getNavigationOrder() {
  const navModule = helpers.getModule('navigation');
  const orderValue = navModule?.settings?.navOrder ?? '';
  if (!orderValue) {
    return [];
  }
  return orderValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isHomeModule(moduleData) {
  const name = moduleData?.name ?? '';
  const displayName = moduleData?.displayName ?? '';
  return (
    name.toLowerCase() === 'home' || displayName.toLowerCase() === 'home'
  );
}

function normalizeCharacters(characters) {
  if (!Array.isArray(characters)) {
    return [];
  }
  return characters.map((character) => {
    if (typeof character === 'string') {
      return {
        name: character,
        characterId: null,
        corporationId: null,
        corporationName: null,
        allianceId: null,
        allianceName: null
      };
    }
    return {
      name: character?.name ?? '',
      characterId: character?.characterId ?? null,
      corporationId: character?.corporationId ?? null,
      corporationName: character?.corporationName ?? null,
      allianceId: character?.allianceId ?? null,
      allianceName: character?.allianceName ?? null
    };
  });
}

function getCharacterPortraitUrl(characterId) {
  if (!characterId) {
    return null;
  }
  return `https://images.evetech.net/characters/${characterId}/portrait?size=128`;
}

function getCorporationLogoUrl(corporationId) {
  if (!corporationId) {
    return null;
  }
  return `https://images.evetech.net/corporations/${corporationId}/logo?size=64`;
}

function startQueueTicker() {
  if (queueTickerId) {
    return;
  }
  queueTickerId = window.setInterval(() => {
    if (!state.account) {
      return;
    }
    const activeHash = window.location.hash;
    if (activeHash === '#/module/home') {
      renderHome();
      return;
    }
    if (activeHash === '#/module/characters') {
      renderCharactersModule();
    }
  }, 1000);
}

function stopQueueTicker() {
  if (queueTickerId) {
    window.clearInterval(queueTickerId);
    queueTickerId = null;
  }
}

function renderNav() {
  nav.innerHTML = '';
  if (!state.account) {
    nav.style.display = 'none';
    return;
  }
  nav.style.display = 'block';
  const container = document.createElement('div');
  container.className = 'nav-inner';

  const list = document.createElement('ul');
  list.className = 'nav-list';

  const moduleItems = state.modules.filter((module) => {
    if (!module.mainPage || module.name === 'landing') {
      return false;
    }
    if (module.hidden || module.config?.region === 'footer') {
      return false;
    }
    if (module.config?.hideFromNav) {
      return false;
    }
    if (module.config?.adminOnly && !state.account?.isAdmin) {
      return false;
    }
    return true;
  });
  const navigationOrder = getNavigationOrder().map((entry) => entry.toLowerCase());
  moduleItems.sort((a, b) => {
    const aIsHome = isHomeModule(a);
    const bIsHome = isHomeModule(b);
    if (aIsHome && !bIsHome) {
      return -1;
    }
    if (bIsHome && !aIsHome) {
      return 1;
    }
    const aIndex = navigationOrder.indexOf(a.name.toLowerCase());
    const bIndex = navigationOrder.indexOf(b.name.toLowerCase());
    if (aIndex === -1 && bIndex === -1) {
      return a.displayName.localeCompare(b.displayName);
    }
    if (aIndex === -1) {
      return 1;
    }
    if (bIndex === -1) {
      return -1;
    }
    return aIndex - bIndex;
  });
  moduleItems.forEach((module) => {
    const item = document.createElement('li');
    item.className = 'nav-item';
    const link = document.createElement('a');
    link.className = 'nav-link';
    link.href = `#/module/${module.name}`;
    link.textContent = module.displayName;
    item.appendChild(link);

    if (module.description) {
      const dropdown = document.createElement('div');
      dropdown.className = 'nav-dropdown';
      const info = document.createElement('a');
      info.textContent = module.description;
      info.href = link.href;
      dropdown.appendChild(info);
      item.appendChild(dropdown);
    }

    list.appendChild(item);
  });

  const actions = document.createElement('div');
  actions.className = 'nav-actions';

  const statusWrap = document.createElement('div');
  statusWrap.className = 'nav-status';
  const statusLine = document.createElement('div');
  statusLine.className = 'nav-status-line';
  const statusValue = helpers.getEsiStatusLabel(state.esiStatus);
  statusLine.innerHTML = `
    <span class="nav-status-label">ESI:</span>
    <span class="nav-status-value">${statusValue}</span>
  `;
  if (getUserEsiTasks().length) {
    const spinner = document.createElement('span');
    spinner.className = 'nav-spinner';
    spinner.title = 'ESI requests in progress';
    statusLine.appendChild(spinner);
  }
  const queueLine = document.createElement('div');
  queueLine.className = 'nav-status-line';
  queueLine.innerHTML = `
    <span class="nav-status-label">Queue:</span>
    <span class="nav-status-value">${state.esiQueue.length}</span>
  `;
  statusWrap.appendChild(statusLine);
  statusWrap.appendChild(queueLine);

  const logoutButton = document.createElement('button');
  logoutButton.className = 'button secondary nav-button';
  logoutButton.type = 'button';
  logoutButton.textContent = 'Log out';
  logoutButton.addEventListener('click', handleLogout);
  actions.appendChild(statusWrap);
  if (state.account?.isAdmin) {
    const navModule = helpers.getModule('navigation');
    if (navModule?.adminSettings) {
      const settingsButton = document.createElement('button');
      settingsButton.className = 'button nav-button nav-settings-button';
      settingsButton.type = 'button';
      settingsButton.textContent = 'Nav settings';
      settingsButton.addEventListener('click', () =>
        openModuleSettings(navModule)
      );
      actions.appendChild(settingsButton);
    }
  }
  actions.appendChild(logoutButton);

  container.appendChild(list);
  container.appendChild(actions);
  nav.appendChild(container);
}

function renderLanding() {
  mainContent.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'centered';
  const card = document.createElement('div');
  card.className = 'card';
  card.style.textAlign = 'center';

  const logo = document.createElement('div');
  logo.className = 'logo';
  logo.textContent = 'FA';

  const title = document.createElement('h1');
  title.className = 'glow-title';
  title.textContent = 'FineAuth';

  const text = document.createElement('p');
  text.textContent = 'Authenticate your alliance and manage EVE Online access with ESI.';

  const buttonGroup = document.createElement('div');
  buttonGroup.className = 'button-group';

  const esiButton = document.createElement('button');
  esiButton.className = 'button secondary';
  esiButton.type = 'button';
  esiButton.textContent = 'Sign in with EVE Online ESI';
  esiButton.addEventListener('click', handleEsiLogin);

  buttonGroup.appendChild(esiButton);

  card.appendChild(logo);
  card.appendChild(title);
  card.appendChild(text);
  if (state.loginError) {
    const errorText = document.createElement('p');
    errorText.className = 'error-text';
    errorText.textContent = state.loginError;
    card.appendChild(errorText);
  }
  card.appendChild(buttonGroup);
  container.appendChild(card);
  mainContent.appendChild(container);
}

function createPanelCard({ title, subtitle }) {
  const card = document.createElement('div');
  card.className = 'panel-card';
  const heading = document.createElement('div');
  heading.className = 'panel-heading';
  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  heading.appendChild(titleEl);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.textContent = subtitle;
    heading.appendChild(sub);
  }
  card.appendChild(heading);
  return { card, heading };
}

function createHomePanel(moduleData) {
  if (moduleData.name === 'characters') {
    return createCharactersPanel(moduleData);
  }
  if (moduleData.name === 'esi-queue') {
    return createEsiQueuePanel(getUserEsiTasks(), moduleData);
  }
  const { card } = createPanelCard({
    title: moduleData.homePanel?.title ?? moduleData.displayName,
    subtitle: moduleData.homePanel?.description ?? moduleData.description
  });
  const meta = document.createElement('div');
  meta.className = 'panel-meta';
  meta.textContent = `Module: ${moduleData.displayName}`;
  card.appendChild(meta);
  const button = document.createElement('button');
  button.className = 'button secondary';
  button.type = 'button';
  button.textContent = 'Open module';
  button.addEventListener('click', () => {
    window.location.hash = `#/module/${moduleData.name}`;
  });
  card.appendChild(button);
  return card;
}

function createCharacterList(
  characters,
  { compact = false, mainName = state.account?.name ?? '' } = {}
) {
  const list = document.createElement('ul');
  list.className = `panel-list character-list${compact ? ' compact' : ''}`;
  const normalized = normalizeCharacters(characters);
  const mainNameLower = mainName.toLowerCase();
  normalized.sort((a, b) => {
    const aIsMain =
      mainNameLower &&
      a.name &&
      a.name.toLowerCase() === mainNameLower;
    const bIsMain =
      mainNameLower &&
      b.name &&
      b.name.toLowerCase() === mainNameLower;
    if (aIsMain && !bIsMain) {
      return -1;
    }
    if (bIsMain && !aIsMain) {
      return 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  if (normalized.length) {
    normalized.forEach((character) => {
      const item = document.createElement('li');
      item.className = 'character-row';
      const isMain =
        mainName &&
        character.name &&
        character.name.toLowerCase() === mainName.toLowerCase();
      if (isMain) {
        item.classList.add('is-main');
      }

      const avatar = document.createElement('div');
      avatar.className = 'character-avatar';
      const portraitUrl = getCharacterPortraitUrl(character.characterId);
      if (portraitUrl) {
        const img = document.createElement('img');
        img.src = portraitUrl;
        img.alt = `${character.name} portrait`;
        avatar.appendChild(img);
      } else {
        avatar.textContent = character.name.slice(0, 1).toUpperCase();
      }

      const info = document.createElement('div');
      info.className = 'character-info';
      const nameRow = document.createElement('div');
      nameRow.className = 'character-name-row';
      const name = document.createElement('div');
      name.className = 'character-name';
      name.textContent = character.name;
      nameRow.appendChild(name);
      if (isMain) {
        const badge = document.createElement('span');
        badge.className = 'character-badge';
        badge.textContent = 'Main';
        nameRow.appendChild(badge);
      }
      info.appendChild(nameRow);

      const meta = document.createElement('div');
      meta.className = 'character-meta';
      const corpName = character.corporationName ?? 'Unknown corporation';
      if (character.allianceName) {
        meta.textContent = `${corpName} • ${character.allianceName}`;
      } else {
        meta.textContent = corpName;
      }
      info.appendChild(meta);

      const corpLogo = document.createElement('div');
      corpLogo.className = 'character-corp-logo';
      const corpLogoUrl = getCorporationLogoUrl(character.corporationId);
      if (corpLogoUrl) {
        const corpImg = document.createElement('img');
        corpImg.src = corpLogoUrl;
        corpImg.alt = `${corpName} logo`;
        corpLogo.appendChild(corpImg);
      }

      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(corpLogo);
      list.appendChild(item);
    });
  } else {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No characters linked yet.';
    list.appendChild(empty);
  }
  return list;
}

function createCharactersPanel(moduleData) {
  const { card } = createPanelCard({
    title: moduleData.homePanel?.title ?? 'Characters',
    subtitle: moduleData.homePanel?.description
  });

  const list = createCharacterList(state.account?.characters ?? [], {
    compact: true
  });
  card.appendChild(list);

  const actionRow = document.createElement('div');
  actionRow.className = 'panel-actions';
  const manageButton = document.createElement('button');
  manageButton.className = 'button secondary';
  manageButton.type = 'button';
  manageButton.textContent = 'Manage characters';
  manageButton.addEventListener('click', () => {
    window.location.hash = '#/module/characters';
  });
  actionRow.appendChild(manageButton);
  card.appendChild(actionRow);

  return card;
}

function createEsiQueuePanel(tasks, moduleData) {
  const { card } = createPanelCard({
    title: moduleData?.homePanel?.title ?? 'Your ESI Queue',
    subtitle:
      moduleData?.homePanel?.description ??
      'Only your in-flight ESI requests are shown.'
  });
  const list = document.createElement('ul');
  list.className = 'panel-list';
  const queueRunSeconds = state.esiQueueMeta.queueRunSeconds ?? 12;
  if (!tasks.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No active ESI requests in your queue.';
    list.appendChild(empty);
  }
  tasks.forEach((task) => {
    const item = document.createElement('li');
    const position = getEsiQueuePosition(task.id);
    const queuedAt = new Date(task.queuedAt).getTime();
    const elapsedSeconds = (Date.now() - queuedAt) / 1000;
    const etaSeconds = queueRunSeconds * (position ?? 1) - elapsedSeconds;
    item.innerHTML = `
      <div class="queue-row">
        <span class="queue-name">${task.taskName} [${position ?? '—'}]</span>
        <span class="queue-meta">ETA ${helpers.formatDuration(etaSeconds)}</span>
      </div>
    `;
    list.appendChild(item);
  });
  card.appendChild(list);
  return card;
}

function renderHome() {
  mainContent.innerHTML = '';
  const panels = [];
  const panelModules = state.modules
    .filter((module) => module.homePanel && !module.hidden)
    .sort(
      (a, b) =>
        (a.homePanel?.position ?? 0) - (b.homePanel?.position ?? 0)
    );

  panelModules.forEach((module) => {
    panels.push(createHomePanel(module));
  });

  const homeModule = helpers.getModule('home');
  const settingsButton = createModuleSettingsButton(homeModule);

  if (!panels.length && !settingsButton) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'module-wrapper';

  if (settingsButton) {
    wrapper.appendChild(settingsButton);
  }

  if (panels.length) {
    const container = document.createElement('div');
    container.className = `home-panels ${getHomeLayout()}`;
    panels.forEach((panel) => container.appendChild(panel));
    wrapper.appendChild(container);
  }

  mainContent.appendChild(wrapper);
}

function renderCharactersModule() {
  mainContent.innerHTML = '';
  const moduleData = helpers.getModule('characters');
  const wrapper = document.createElement('div');
  wrapper.className = 'module-wrapper';
  const settingsButton = createModuleSettingsButton(moduleData);
  if (settingsButton) {
    wrapper.appendChild(settingsButton);
  }

  const card = document.createElement('div');
  card.className = 'card characters-card';
  const title = document.createElement('h2');
  title.textContent = 'Characters';
  card.appendChild(title);

  const description = document.createElement('p');
  description.textContent =
    'Use ESI OAuth to link additional characters to your FineAuth account.';
  card.appendChild(description);

  if (state.charactersError) {
    const error = document.createElement('p');
    error.className = 'error-text';
    error.textContent = state.charactersError;
    card.appendChild(error);
  }

  const list = createCharacterList(state.account?.characters ?? []);
  card.appendChild(list);

  const actionRow = document.createElement('div');
  actionRow.className = 'panel-actions';
  const addButton = document.createElement('button');
  addButton.className = 'button';
  addButton.type = 'button';
  addButton.textContent = 'Add character via ESI';
  addButton.addEventListener('click', handleAddCharacter);
  actionRow.appendChild(addButton);
  const refreshButton = document.createElement('button');
  refreshButton.className = 'button secondary';
  refreshButton.type = 'button';
  refreshButton.textContent = state.charactersRefreshing
    ? 'Refreshing ESI details...'
    : 'Refresh ESI details';
  refreshButton.disabled = state.charactersRefreshing;
  refreshButton.addEventListener('click', handleRefreshCharacters);
  actionRow.appendChild(refreshButton);
  card.appendChild(actionRow);

  wrapper.appendChild(card);
  mainContent.appendChild(wrapper);
}

function requestAdminAccounts() {
  if (!socket || !state.account?.isAdmin || state.admin.loadingAccounts) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.loadingAccounts = true;
  socket.emit('admin:accounts:request', { token }, (response) => {
    state.admin.loadingAccounts = false;
    if (response?.accounts) {
      state.admin.accounts = response.accounts;
      if (!state.admin.selectedAccountId && state.admin.accounts.length) {
        state.admin.selectedAccountId = state.admin.accounts[0].id;
      }
    }
    renderAdminModule();
  });
}

function requestAdminSettings() {
  if (!socket || !state.account?.isAdmin || state.admin.loadingSettings) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.loadingSettings = true;
  socket.emit(
    'module:settings:request',
    { token, moduleName: 'admin' },
    (response) => {
      state.admin.loadingSettings = false;
      if (!response?.error) {
        state.admin.settings = response;
      }
      renderAdminModule();
    }
  );
}

function getAdminSettingDefault(fieldId) {
  const fields = state.admin.settings?.adminSettings?.fields ?? [];
  const field = fields.find((entry) => entry.id === fieldId);
  return field?.default;
}

function getAdminSettingValue(fieldId) {
  return (
    state.admin.settings?.settings?.[fieldId] ??
    getAdminSettingDefault(fieldId) ??
    ''
  );
}

function getAdminDataCooldownMs(type) {
  const fieldMap = {
    mail: 'mailDataCooldown',
    skills: 'skillsDataCooldown',
    history: 'historyDataCooldown'
  };
  const fieldId = fieldMap[type];
  const value = fieldId ? getAdminSettingValue(fieldId) : '';
  const parsed = parseDurationInput(value);
  const fallbackSeconds = 15;
  const totalSeconds = parsed.totalSeconds || fallbackSeconds;
  return totalSeconds * 1000;
}

function getAdminAutoCooldownMs() {
  const cooldowns = ['mail', 'skills', 'history'].map(getAdminDataCooldownMs);
  return Math.min(...cooldowns);
}

function getAdminCooldownRemainingMs(type) {
  const cooldownMs =
    type === 'auto' ? getAdminAutoCooldownMs() : getAdminDataCooldownMs(type);
  const lastAt = state.admin.lastDataRequestAt?.[type];
  if (!lastAt) {
    return 0;
  }
  const remaining = cooldownMs - (Date.now() - lastAt);
  return Math.max(0, remaining);
}

function updateAdminDataRequestTimestamps() {
  const timestamp = Date.now();
  state.admin.lastDataRequestAt = {
    ...state.admin.lastDataRequestAt,
    auto: timestamp,
    mail: timestamp,
    skills: timestamp,
    history: timestamp
  };
}

function requestAdminData({ type = 'auto', force = false } = {}) {
  if (
    !socket ||
    !state.account?.isAdmin ||
    state.admin.loadingData ||
    !state.admin.selectedAccountId
  ) {
    return;
  }
  const remainingCooldownMs = getAdminCooldownRemainingMs(type);
  if (remainingCooldownMs > 0) {
    return;
  }
  if (
    state.admin.data?.accountId === state.admin.selectedAccountId &&
    state.admin.data?.payload &&
    !force
  ) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.loadingData = true;
  state.admin.dataError = null;
  updateAdminDataRequestTimestamps();
  socket.emit(
    'admin:data:request',
    { token, accountId: state.admin.selectedAccountId },
    (response) => {
      state.admin.loadingData = false;
      if (response?.error) {
        state.admin.data = null;
        state.admin.dataError = response.error;
      } else {
        state.admin.data = {
          accountId: response?.accountId ?? state.admin.selectedAccountId,
          payload: response?.data ?? null
        };
        state.admin.dataError = null;
      }
      renderAdminModule();
    }
  );
}

function resetAdminMailState() {
  state.admin.mailPage = 1;
  state.admin.mailSelectedId = null;
  state.admin.mail = {
    labelsByCharacter: {},
    labelsLoading: new Set(),
    labelsError: {},
    selectedLabelByCharacter: {},
    mailHeadersByLabel: {},
    mailHeadersLoading: new Set(),
    mailHeadersError: {},
    mailDetailCache: {},
    mailDetailLoading: new Set()
  };
}

function requestAdminMailLabels({ characterId } = {}) {
  if (
    !socket ||
    !state.account?.isAdmin ||
    !state.admin.selectedAccountId ||
    characterId == null
  ) {
    return;
  }
  if (state.admin.mail.labelsLoading.has(characterId)) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.mail.labelsLoading.add(characterId);
  socket.emit(
    'admin:mail:labels:request',
    { token, accountId: state.admin.selectedAccountId, characterId },
    (response) => {
      state.admin.mail.labelsLoading.delete(characterId);
      if (response?.error) {
        state.admin.mail.labelsError[characterId] = response.error;
      } else {
        const labels = response?.labels ?? [];
        state.admin.mail.labelsByCharacter[characterId] = labels;
        state.admin.mail.labelsError[characterId] = null;
        if (
          labels.length &&
          !state.admin.mail.selectedLabelByCharacter[characterId]
        ) {
          state.admin.mail.selectedLabelByCharacter[characterId] =
            labels[0].label_id ?? labels[0].id ?? null;
        }
      }
      renderAdminModule();
    }
  );
}

function requestAdminMailHeaders({ characterId, labelId, fetchAll = false } = {}) {
  if (
    !socket ||
    !state.account?.isAdmin ||
    !state.admin.selectedAccountId ||
    characterId == null ||
    labelId == null
  ) {
    return;
  }
  const key = `${characterId}:${labelId}`;
  if (state.admin.mail.mailHeadersLoading.has(key)) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.mail.mailHeadersLoading.add(key);
  socket.emit(
    'admin:mail:list:request',
    {
      token,
      accountId: state.admin.selectedAccountId,
      characterId,
      labelId,
      fetchAll
    },
    (response) => {
      state.admin.mail.mailHeadersLoading.delete(key);
      if (response?.error) {
        state.admin.mail.mailHeadersError[key] = response.error;
      } else {
        state.admin.mail.mailHeadersByLabel[key] = response?.mail ?? [];
        state.admin.mail.mailHeadersError[key] = null;
      }
      renderAdminModule();
    }
  );
}

function requestAdminMailDetail({ characterId, mailId } = {}) {
  if (
    !socket ||
    !state.account?.isAdmin ||
    !state.admin.selectedAccountId ||
    characterId == null ||
    mailId == null
  ) {
    return;
  }
  const key = `${characterId}:${mailId}`;
  if (state.admin.mail.mailDetailLoading.has(key)) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.admin.mail.mailDetailLoading.add(key);
  socket.emit(
    'admin:mail:detail:request',
    { token, accountId: state.admin.selectedAccountId, characterId, mailId },
    (response) => {
      state.admin.mail.mailDetailLoading.delete(key);
      if (!response?.error) {
        state.admin.mail.mailDetailCache[key] = response?.detail ?? null;
      }
      renderAdminModule();
    }
  );
}

function ensureAdminData() {
  if (!state.admin.accounts.length && !state.admin.loadingAccounts) {
    requestAdminAccounts();
  }
  if (!state.admin.settings && !state.admin.loadingSettings) {
    requestAdminSettings();
  }
  const cooldownRemainingMs = getAdminCooldownRemainingMs('auto');
  const shouldRefreshData =
    state.admin.selectedAccountId &&
    !state.admin.loadingData &&
    (state.admin.data?.accountId !== state.admin.selectedAccountId ||
      (!state.admin.data?.payload &&
        cooldownRemainingMs === 0));
  if (shouldRefreshData) {
    requestAdminData({ type: 'auto' });
  }
}

function getAdminAccountOptions() {
  return [...state.admin.accounts].sort((a, b) => {
    if (a.createdAt && b.createdAt) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    }
    return a.name.localeCompare(b.name);
  });
}

function getAdminFeatureDefinitions() {
  return [
    { key: 'mail', label: 'Mail Browser' },
    { key: 'skills', label: 'Skills & Training' },
    { key: 'history', label: 'ISK History' }
  ];
}

function createAdminDataActionRow({ type, label }) {
  const row = document.createElement('div');
  row.className = 'admin-data-actions';
  const button = document.createElement('button');
  button.className = 'button secondary';
  button.type = 'button';
  button.textContent = label;
  const remainingMs = getAdminCooldownRemainingMs(type);
  button.disabled = state.admin.loadingData || remainingMs > 0;
  button.addEventListener('click', () => {
    requestAdminData({ type, force: true });
  });
  row.appendChild(button);
  if (remainingMs > 0) {
    const cooldown = document.createElement('span');
    cooldown.className = 'admin-data-cooldown';
    cooldown.textContent = `Cooldown: ${helpers.formatDuration(
      Math.ceil(remainingMs / 1000)
    )}`;
    row.appendChild(cooldown);
  }
  return row;
}

function getAdminPayload() {
  return state.admin.data?.payload ?? null;
}

function getAdminCharacters() {
  const payload = getAdminPayload();
  const primaryCharacters = payload?.characters ?? [];
  const subaccounts = payload?.subaccounts ?? [];
  const subCharacters = subaccounts.flatMap(
    (account) => account?.characters ?? []
  );
  return [...primaryCharacters, ...subCharacters];
}

function formatIsk(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'N/A';
  }
  return value.toLocaleString();
}

function getMailLabelKey(characterId, labelId) {
  return `${characterId}:${labelId ?? 'unknown'}`;
}

function getMailDetailKey(characterId, mailId) {
  return `${characterId}:${mailId ?? 'unknown'}`;
}

function getMailLabelDisplayName(label) {
  return label?.name ?? label?.label_name ?? `Label ${label?.label_id ?? ''}`;
}

function getMailPagination(totalItems, pageSize) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(
    Math.max(1, state.admin.mailPage),
    totalPages
  );
  return { totalPages, currentPage };
}

function getQueueProgressPercent(entry) {
  if (!entry?.start_date || !entry?.finish_date) {
    return null;
  }
  const start = new Date(entry.start_date).getTime();
  const finish = new Date(entry.finish_date).getTime();
  if (!start || !finish || finish <= start) {
    return null;
  }
  const now = Date.now();
  const percent = ((now - start) / (finish - start)) * 100;
  return Math.min(100, Math.max(0, percent));
}

function formatMailParticipant(participant) {
  if (!participant) {
    return 'Unknown';
  }
  if (typeof participant === 'string') {
    return participant;
  }
  if (participant.name) {
    return participant.name;
  }
  if (participant.recipient_name) {
    return participant.recipient_name;
  }
  if (participant.recipient_id) {
    return `ID ${participant.recipient_id}`;
  }
  if (participant.id) {
    return `ID ${participant.id}`;
  }
  return 'Unknown';
}

function ensureAdminSelection() {
  if (state.admin.selectedAccountId || !state.admin.accounts.length) {
    return;
  }
  state.admin.selectedAccountId = state.admin.accounts[0].id;
}

function renderAdminSettingsPanel(wrapper) {
  if (!state.admin.settingsOpen) {
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'admin-settings-panel';

  const header = document.createElement('div');
  header.className = 'admin-settings-header';
  const title = document.createElement('h3');
  title.textContent = 'Admin Settings';
  const closeButton = document.createElement('button');
  closeButton.className = 'button secondary';
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  closeButton.addEventListener('click', () => {
    state.admin.settingsOpen = false;
    renderAdminModule();
  });
  header.appendChild(title);
  header.appendChild(closeButton);
  panel.appendChild(header);

  if (!state.admin.settings) {
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = 'Loading settings...';
    panel.appendChild(loading);
    wrapper.appendChild(panel);
    return;
  }

  const fields = state.admin.settings.adminSettings?.fields ?? [];
  const featureGroups = new Map();
  fields.forEach((field) => {
    const groupKey = field.feature ?? 'general';
    if (!featureGroups.has(groupKey)) {
      featureGroups.set(groupKey, []);
    }
    featureGroups.get(groupKey).push(field);
  });

  const orderedGroups = getAdminFeatureDefinitions().map((feature) => ({
    key: feature.key,
    label: feature.label,
    fields: featureGroups.get(feature.key) ?? []
  }));
  const orderedKeys = new Set(orderedGroups.map((group) => group.key));
  featureGroups.forEach((groupFields, key) => {
    if (!orderedKeys.has(key)) {
      orderedGroups.push({
        key,
        label: key === 'general' ? 'General' : key,
        fields: groupFields
      });
    }
  });

  orderedGroups.forEach((group, index) => {
    const details = document.createElement('details');
    details.className = 'card admin-settings-group';
    details.open = state.admin.expandedSettingGroups.has(group.key);
    details.addEventListener('toggle', () => {
      if (details.open) {
        state.admin.expandedSettingGroups.add(group.key);
      } else {
        state.admin.expandedSettingGroups.delete(group.key);
      }
    });

    const summary = document.createElement('summary');
    summary.className = 'admin-settings-summary';
    summary.textContent = group.label;
    details.appendChild(summary);

    if (!group.fields.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No settings available for this group yet.';
      details.appendChild(empty);
      panel.appendChild(details);
      return;
    }

    group.fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'admin-settings-field';
      const label = document.createElement('label');
      label.textContent = field.label ?? field.id ?? 'Setting';
      row.appendChild(label);

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        (field.options ?? []).forEach((option) => {
          const optionEl = document.createElement('option');
          optionEl.value = option;
          optionEl.textContent = option;
          input.appendChild(optionEl);
        });
        input.value =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? '';
      } else if (field.type === 'toggle') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? false;
      } else if (field.type === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.value =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? '';
      } else if (field.type === 'duration') {
        input = document.createElement('input');
        input.type = 'text';
        input.value =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? '';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? '';
      }
      input.dataset.fieldId = field.id;
      input.dataset.fieldType = field.type ?? 'text';
      if (field.type === 'duration') {
        const summary = document.createElement('p');
        summary.className = 'duration-summary';
        summary.textContent = getDurationSummary(input.value);
        input.addEventListener('input', () => {
          summary.textContent = getDurationSummary(input.value);
        });
        row.appendChild(summary);
      }
      row.appendChild(input);

      if (field.help) {
        const help = document.createElement('p');
        help.className = 'modal-help';
        help.textContent = field.help;
        row.appendChild(help);
      }
      details.appendChild(row);
    });

    panel.appendChild(details);
  });

  const actions = document.createElement('div');
  actions.className = 'admin-settings-actions';
  const saveButton = document.createElement('button');
  saveButton.className = 'button';
  saveButton.type = 'button';
  saveButton.textContent = 'Save settings';
  saveButton.addEventListener('click', () => {
    const token = localStorage.getItem('fineauth_token');
    const nextSettings = {
      ...(state.admin.settings?.settings ?? {})
    };
    panel.querySelectorAll('[data-field-id]').forEach((inputEl) => {
      const fieldId = inputEl.dataset.fieldId;
      const fieldType = inputEl.dataset.fieldType;
      if (fieldType === 'toggle') {
        nextSettings[fieldId] = inputEl.checked;
      } else {
        nextSettings[fieldId] = inputEl.value;
      }
    });
    socket.emit(
      'module:settings:update',
      {
        token,
        moduleName: 'admin',
        settings: nextSettings
      },
      (response) => {
        if (response?.ok) {
          state.admin.settings = {
            ...state.admin.settings,
            settings: nextSettings
          };
        }
        state.admin.settingsOpen = false;
        renderAdminModule();
      }
    );
  });
  actions.appendChild(saveButton);
  panel.appendChild(actions);

  wrapper.appendChild(panel);
}

function renderAdminModule() {
  mainContent.innerHTML = '';
  if (!state.account?.isAdmin) {
    renderHome();
    return;
  }
  ensureAdminData();
  ensureAdminSelection();
  const adminPayload = getAdminPayload();
  const adminCharacters = getAdminCharacters();
  const updatedAtLabel = adminPayload?.updatedAt
    ? new Date(adminPayload.updatedAt).toLocaleString()
    : 'No sync yet';

  const wrapper = document.createElement('div');
  wrapper.className = 'module-wrapper admin-module';

  const headerCard = document.createElement('div');
  headerCard.className = 'card admin-header-card';
  const headerTitle = document.createElement('h2');
  headerTitle.textContent = 'Admin';
  headerCard.appendChild(headerTitle);

  const headerText = document.createElement('p');
  headerText.textContent =
    'Select a main account and review mail, skills, and ISK data across the auth.';
  headerCard.appendChild(headerText);
  const headerMeta = document.createElement('p');
  headerMeta.className = 'muted';
  headerMeta.textContent = `Last sync: ${updatedAtLabel}`;
  headerCard.appendChild(headerMeta);

  const accountRow = document.createElement('div');
  accountRow.className = 'admin-account-row';
  const accountLabel = document.createElement('label');
  accountLabel.textContent = 'Main account';
  const accountSelect = document.createElement('select');
  accountSelect.disabled = state.admin.loadingAccounts;
  const options = getAdminAccountOptions();
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = state.admin.loadingAccounts
      ? 'Loading accounts...'
      : 'No accounts found';
    accountSelect.appendChild(option);
  } else {
    options.forEach((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      const createdAt = account.createdAt
        ? new Date(account.createdAt).toLocaleDateString()
        : 'Unknown date';
      option.textContent = `${account.name} • ${createdAt}`;
      accountSelect.appendChild(option);
    });
  }
  if (state.admin.selectedAccountId) {
    accountSelect.value = String(state.admin.selectedAccountId);
  } else if (options.length) {
    state.admin.selectedAccountId = options[0].id;
    accountSelect.value = String(state.admin.selectedAccountId);
  }
  accountSelect.addEventListener('change', (event) => {
    const nextId = Number(event.target.value);
    state.admin.selectedAccountId = Number.isNaN(nextId) ? null : nextId;
    state.admin.data = null;
    state.admin.dataError = null;
    state.admin.lastDataRequestAt = {};
    resetAdminMailState();
    renderAdminModule();
  });
  accountRow.appendChild(accountLabel);
  accountRow.appendChild(accountSelect);
  headerCard.appendChild(accountRow);
  wrapper.appendChild(headerCard);

  const featureGrid = document.createElement('div');
  featureGrid.className = 'admin-feature-grid';

  getAdminFeatureDefinitions().forEach((feature, index) => {
    const details = document.createElement('details');
    details.className = 'card admin-feature-card';
    details.open = state.admin.expandedFeatures.has(feature.key);
    details.addEventListener('toggle', () => {
      if (details.open) {
        state.admin.expandedFeatures.add(feature.key);
      } else {
        state.admin.expandedFeatures.delete(feature.key);
      }
    });

    const summary = document.createElement('summary');
    summary.className = 'admin-feature-summary';
    summary.textContent = feature.label;
    details.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'admin-feature-content';

    if (feature.key === 'mail') {
      const list = document.createElement('div');
      list.className = 'admin-empty-state';
      if (state.admin.dataError) {
        list.textContent = `Unable to load admin data: ${state.admin.dataError}`;
        content.appendChild(list);
      } else if (!adminCharacters.length) {
        list.textContent = state.admin.loadingData
          ? 'Loading character data...'
          : 'No characters are available for this account yet.';
        content.appendChild(list);
      } else {
        list.innerHTML = '';
        adminCharacters.forEach((character) => {
          const characterId = character.characterId ?? character.character_id ?? null;
          const mailCard = document.createElement('div');
          mailCard.className = 'card admin-mail-card';

          const header = document.createElement('div');
          header.className = 'admin-mail-card-header';
          const title = document.createElement('h4');
          title.textContent = character.name ?? 'Unknown character';
          header.appendChild(title);
          mailCard.appendChild(header);

          if (!characterId) {
            const missing = document.createElement('p');
            missing.className = 'muted';
            missing.textContent = 'Character ID unavailable for mail lookups.';
            mailCard.appendChild(missing);
            list.appendChild(mailCard);
            return;
          }

          const labels =
            state.admin.mail.labelsByCharacter[characterId] ?? [];
          const labelsError = state.admin.mail.labelsError[characterId];
          const labelsLoading = state.admin.mail.labelsLoading.has(characterId);
          if (!labels.length && !labelsLoading) {
            requestAdminMailLabels({ characterId });
          }

          const labelRow = document.createElement('div');
          labelRow.className = 'admin-mail-labels';

          if (labelsLoading) {
            const loading = document.createElement('span');
            loading.className = 'muted';
            loading.textContent = '⏳ Loading labels...';
            labelRow.appendChild(loading);
          } else if (labelsError) {
            const error = document.createElement('span');
            error.className = 'muted';
            error.textContent = `Unable to load labels: ${labelsError}`;
            labelRow.appendChild(error);
          } else if (!labels.length) {
            const empty = document.createElement('span');
            empty.className = 'muted';
            empty.textContent = 'No labels found for this character.';
            labelRow.appendChild(empty);
          } else {
            const selectedLabelId =
              state.admin.mail.selectedLabelByCharacter[characterId];
            labels.forEach((label) => {
              const labelId = label.label_id ?? label.id ?? null;
              const button = document.createElement('button');
              button.type = 'button';
              button.className = 'multi-select-button admin-mail-label-button';
              if (selectedLabelId === labelId) {
                button.classList.add('is-selected');
              }
              const unreadCount = label.unread_count ?? null;
              const labelName = getMailLabelDisplayName(label);
              button.textContent =
                typeof unreadCount === 'number'
                  ? `${labelName} (${unreadCount})`
                  : labelName;
              button.addEventListener('click', () => {
                const nextLabel =
                  selectedLabelId === labelId ? null : labelId;
                state.admin.mail.selectedLabelByCharacter[characterId] = nextLabel;
                state.admin.mailSelectedId = null;
                state.admin.mailPage = 1;
                if (nextLabel) {
                  requestAdminMailHeaders({
                    characterId,
                    labelId: nextLabel
                  });
                }
                renderAdminModule();
              });
              labelRow.appendChild(button);
            });
          }
          mailCard.appendChild(labelRow);

          const selectedLabelId =
            state.admin.mail.selectedLabelByCharacter[characterId];
          if (selectedLabelId) {
            const fetchAllRow = document.createElement('div');
            fetchAllRow.className = 'admin-mail-actions';
            const fetchAllButton = document.createElement('button');
            fetchAllButton.type = 'button';
            fetchAllButton.className = 'button secondary admin-mail-fetch-all';
            fetchAllButton.textContent = 'Fetch all mail for selected label';
            fetchAllButton.addEventListener('click', () => {
              requestAdminMailHeaders({
                characterId,
                labelId: selectedLabelId,
                fetchAll: true
              });
            });
            fetchAllRow.appendChild(fetchAllButton);
            mailCard.appendChild(fetchAllRow);
          }

          const mailListWrapper = document.createElement('div');
          mailListWrapper.className = 'admin-mail-list';
          if (!selectedLabelId) {
            const prompt = document.createElement('p');
            prompt.className = 'muted';
            prompt.textContent = 'Select a label to view mail headers.';
            mailListWrapper.appendChild(prompt);
          } else {
            const mailKey = getMailLabelKey(characterId, selectedLabelId);
            const mailItems =
              state.admin.mail.mailHeadersByLabel[mailKey] ?? [];
            const mailLoading = state.admin.mail.mailHeadersLoading.has(mailKey);
            const mailError = state.admin.mail.mailHeadersError[mailKey];
            if (!mailItems.length && !mailLoading) {
              requestAdminMailHeaders({
                characterId,
                labelId: selectedLabelId
              });
            }
            if (mailLoading && !mailItems.length) {
              const loading = document.createElement('p');
              loading.className = 'muted';
              loading.textContent = '⏳ Loading mail headers...';
              mailListWrapper.appendChild(loading);
            } else if (mailError) {
              const error = document.createElement('p');
              error.className = 'muted';
              error.textContent = `Unable to load mail: ${mailError}`;
              mailListWrapper.appendChild(error);
            } else if (!mailItems.length) {
              const empty = document.createElement('p');
              empty.className = 'muted';
              empty.textContent = 'No mail found for this label.';
              mailListWrapper.appendChild(empty);
            } else {
              const sortedMail = [...mailItems].sort((a, b) => {
                const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return bTime - aTime;
              });
              const mailList = document.createElement('ul');
              mailList.className = 'panel-list';
              const pageSize = 10;
              const { totalPages, currentPage } = getMailPagination(
                sortedMail.length,
                pageSize
              );
              const startIndex = (currentPage - 1) * pageSize;
              const pageItems = sortedMail.slice(
                startIndex,
                startIndex + pageSize
              );
              pageItems.forEach((mail) => {
                const entry = document.createElement('li');
                const subject = mail.subject ?? 'Untitled mail';
                const timestamp = mail.timestamp
                  ? new Date(mail.timestamp).toLocaleString()
                  : 'Unknown time';
                const mailId = mail.mail_id ?? mail.mailId ?? mail.id ?? null;
                const detailKey = getMailDetailKey(characterId, mailId);
                const subjectButton = document.createElement('button');
                subjectButton.type = 'button';
                subjectButton.className = 'admin-mail-subject';
                subjectButton.textContent = subject;
                subjectButton.addEventListener('click', () => {
                  state.admin.mailSelectedId =
                    state.admin.mailSelectedId === detailKey ? null : detailKey;
                  renderAdminModule();
                });
                const row = document.createElement('div');
                row.className = 'queue-row';
                const nameWrapper = document.createElement('div');
                nameWrapper.className = 'queue-name';
                nameWrapper.appendChild(subjectButton);
                row.appendChild(nameWrapper);
                const meta = document.createElement('span');
                meta.className = 'queue-meta';
                meta.textContent = `${character.name} • ${timestamp}`;
                row.appendChild(meta);
                entry.appendChild(row);

                if (state.admin.mailSelectedId === detailKey) {
                  const detail =
                    state.admin.mail.mailDetailCache[detailKey] ?? null;
                  const isDetailLoading =
                    state.admin.mail.mailDetailLoading.has(detailKey);
                  if (!detail && !isDetailLoading) {
                    requestAdminMailDetail({ characterId, mailId });
                  }
                  const detailWrapper = document.createElement('div');
                  detailWrapper.className = 'admin-mail-detail';
                  if (!detail) {
                    const loading = document.createElement('p');
                    loading.className = 'muted';
                    loading.textContent = '⏳ Loading mail details...';
                    detailWrapper.appendChild(loading);
                  } else {
                    const fromText = formatMailParticipant(detail.from ?? mail.from ?? null);
                    const recipients = detail.recipients ?? [];
                    const toText = Array.isArray(recipients)
                      ? recipients.map(formatMailParticipant).join(', ')
                      : formatMailParticipant(recipients);
                    const metaRow = document.createElement('div');
                    metaRow.className = 'admin-mail-meta';
                    metaRow.innerHTML = `
                      <span><strong>From:</strong> ${fromText}</span>
                      <span><strong>To:</strong> ${toText || 'Unknown'}</span>
                    `;
                    detailWrapper.appendChild(metaRow);
                    const body = document.createElement('div');
                    body.className = 'admin-mail-body';
                    body.textContent = detail.body ?? 'No content available.';
                    detailWrapper.appendChild(body);
                  }
                  entry.appendChild(detailWrapper);
                }
                mailList.appendChild(entry);
              });
              mailListWrapper.appendChild(mailList);

              const pagination = document.createElement('div');
              pagination.className = 'admin-pagination';
              const pageLabel = document.createElement('span');
              pageLabel.className = 'muted';
              pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
              const prevButton = document.createElement('button');
              prevButton.className = 'button secondary';
              prevButton.type = 'button';
              prevButton.textContent = 'Previous';
              prevButton.disabled = currentPage <= 1;
              prevButton.addEventListener('click', () => {
                state.admin.mailPage = Math.max(1, currentPage - 1);
                renderAdminModule();
              });
              const nextButton = document.createElement('button');
              nextButton.className = 'button secondary';
              nextButton.type = 'button';
              nextButton.textContent = 'Next';
              nextButton.disabled = currentPage >= totalPages;
              nextButton.addEventListener('click', () => {
                state.admin.mailPage = Math.min(totalPages, currentPage + 1);
                renderAdminModule();
              });
              pagination.appendChild(prevButton);
              pagination.appendChild(pageLabel);
              pagination.appendChild(nextButton);
              mailListWrapper.appendChild(pagination);
            }
          }

          mailCard.appendChild(mailListWrapper);
          list.appendChild(mailCard);
        });
        content.appendChild(list);
      }
    }

    if (feature.key === 'skills') {
      content.appendChild(
        createAdminDataActionRow({
          type: 'skills',
          label: 'Refresh skills data'
        })
      );
      const skillsCard = document.createElement('div');
      skillsCard.className = 'card';
      const title = document.createElement('h4');
      title.textContent = 'Skills Overview';
      skillsCard.appendChild(title);
      const skillsList = document.createElement('div');
      skillsList.className = 'admin-skill-list';
      if (state.admin.loadingData) {
        const loading = document.createElement('p');
        loading.className = 'muted';
        loading.textContent = 'Loading skill data...';
        skillsList.appendChild(loading);
      } else if (state.admin.dataError) {
        const error = document.createElement('p');
        error.className = 'muted';
        error.textContent = `Unable to load skills: ${state.admin.dataError}`;
        skillsList.appendChild(error);
      } else if (!adminCharacters.length) {
        const emptySkill = document.createElement('p');
        emptySkill.className = 'muted';
        emptySkill.textContent = 'No skill data loaded for the selected account.';
        skillsList.appendChild(emptySkill);
      } else {
        adminCharacters.forEach((character) => {
          const entry = document.createElement('details');
          entry.className = 'card admin-skill-card';
          const totalSp = character.skills?.total_sp ?? null;
          const skillEntries = character.skills?.skills ?? [];
          const skillCount = skillEntries.length;
          const summary = document.createElement('summary');
          summary.className = 'admin-skill-summary';
          summary.innerHTML = `
            <span>${character.name}</span>
            <span class="queue-meta">${formatIsk(totalSp)} SP • ${skillCount} skills</span>
          `;
          entry.appendChild(summary);

          const detailList = document.createElement('ul');
          detailList.className = 'panel-list';
          if (!skillEntries.length) {
            const empty = document.createElement('li');
            empty.className = 'muted';
            empty.textContent = 'No skills available.';
            detailList.appendChild(empty);
          } else {
            skillEntries.forEach((skill) => {
              const item = document.createElement('li');
              const skillName =
                skill.name ?? `Skill ${skill.skill_id ?? 'Unknown'}`;
              const level =
                skill.trained_skill_level ?? skill.level ?? 'Unknown';
              item.innerHTML = `
                <div class="queue-row">
                  <span class="queue-name">${skillName}</span>
                  <span class="queue-meta">Level ${level}</span>
                </div>
              `;
              detailList.appendChild(item);
            });
          }
          entry.appendChild(detailList);
          skillsList.appendChild(entry);
        });
      }
      skillsCard.appendChild(skillsList);
      content.appendChild(skillsCard);

      const queueCard = document.createElement('div');
      queueCard.className = 'card';
      const queueTitle = document.createElement('h4');
      queueTitle.textContent = 'Training Queue';
      queueCard.appendChild(queueTitle);
      const queueList = document.createElement('ul');
      queueList.className = 'panel-list';
      const queueItems = adminCharacters.flatMap((character) =>
        (character.trainingQueue ?? []).map((entry) => ({
          ...entry,
          characterName: character.name
        }))
      );
      if (state.admin.loadingData) {
        const loadingQueue = document.createElement('li');
        loadingQueue.className = 'muted';
        loadingQueue.textContent = 'Loading training queue...';
        queueList.appendChild(loadingQueue);
      } else if (state.admin.dataError) {
        const errorQueue = document.createElement('li');
        errorQueue.className = 'muted';
        errorQueue.textContent = `Unable to load training queue: ${state.admin.dataError}`;
        queueList.appendChild(errorQueue);
      } else if (!queueItems.length) {
        const emptyQueue = document.createElement('li');
        emptyQueue.className = 'muted';
        emptyQueue.textContent = 'No active training queue entries.';
        queueList.appendChild(emptyQueue);
      } else {
        queueItems.forEach((entry) => {
          const item = document.createElement('li');
          const finishTime = entry.finish_date
            ? new Date(entry.finish_date).toLocaleString()
            : 'Unknown';
          const level = entry.finished_level ?? entry.level ?? 'Unknown';
          const skillName = entry.skill_name ?? `Skill ${entry.skill_id ?? ''}`;
          const progress = getQueueProgressPercent(entry);
          const progressLabel =
            progress === null
              ? 'Training progress unavailable'
              : `Training ${Math.round(progress)}%`;
          item.innerHTML = `
            <div class="queue-row">
              <span class="queue-name">${skillName} • Level ${level} (${entry.characterName})</span>
              <span class="queue-meta">Finishes ${finishTime}</span>
            </div>
            <div class="admin-queue-progress">
              <div class="admin-queue-progress-bar" style="width: ${
                progress ?? 0
              }%"></div>
            </div>
            <div class="queue-meta">${progressLabel}</div>
          `;
          queueList.appendChild(item);
        });
      }
      queueCard.appendChild(queueList);
      content.appendChild(queueCard);
    }

    if (feature.key === 'history') {
      content.appendChild(
        createAdminDataActionRow({
          type: 'history',
          label: 'Refresh ISK history'
        })
      );
      const walletCard = document.createElement('div');
      walletCard.className = 'card';
      const walletTitle = document.createElement('h4');
      walletTitle.textContent = 'ISK Snapshot';
      walletCard.appendChild(walletTitle);
      const walletList = document.createElement('ul');
      walletList.className = 'panel-list';
      if (state.admin.loadingData) {
        const loading = document.createElement('li');
        loading.className = 'muted';
        loading.textContent = 'Loading wallet data...';
        walletList.appendChild(loading);
      } else if (state.admin.dataError) {
        const error = document.createElement('li');
        error.className = 'muted';
        error.textContent = `Unable to load wallet data: ${state.admin.dataError}`;
        walletList.appendChild(error);
      } else if (!adminCharacters.length) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'ISK totals will appear once wallet data syncs.';
        walletList.appendChild(empty);
      } else {
        adminCharacters.forEach((character) => {
          const item = document.createElement('li');
          const balance =
            typeof character.wallet === 'number' ? character.wallet : null;
          item.innerHTML = `
            <div class="queue-row">
              <span class="queue-name">${character.name}</span>
              <span class="queue-meta">${formatIsk(balance)} ISK</span>
            </div>
          `;
          walletList.appendChild(item);
        });
        const totalBalance = adminCharacters.reduce((sum, character) => {
          const balance = character.wallet;
          return typeof balance === 'number' ? sum + balance : sum;
        }, 0);
        const totalItem = document.createElement('li');
        totalItem.innerHTML = `
          <div class="queue-row">
            <span class="queue-name"><strong>Overall total</strong></span>
            <span class="queue-meta"><strong>${formatIsk(
              totalBalance
            )} ISK</strong></span>
          </div>
        `;
        walletList.appendChild(totalItem);
      }
      walletCard.appendChild(walletList);
      content.appendChild(walletCard);

      const historyCard = document.createElement('div');
      historyCard.className = 'card';
      const title = document.createElement('h4');
      title.textContent = 'ISK History';
      historyCard.appendChild(title);
      const historyWrapper = document.createElement('div');
      historyWrapper.className = 'admin-history-list';
      const walletHistory = getAdminPayload()?.walletHistory ?? null;
      if (state.admin.loadingData) {
        const loading = document.createElement('p');
        loading.className = 'muted';
        loading.textContent = 'Loading ISK history...';
        historyWrapper.appendChild(loading);
      } else if (state.admin.dataError) {
        const error = document.createElement('p');
        error.className = 'muted';
        error.textContent = `Unable to load ISK history: ${state.admin.dataError}`;
        historyWrapper.appendChild(error);
      } else if (!walletHistory) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No ISK history data available yet for the selected account.';
        historyWrapper.appendChild(empty);
      } else {
        const overallDetails = document.createElement('details');
        overallDetails.className = 'admin-history-card';
        const overallSummary = document.createElement('summary');
        overallSummary.textContent = 'Overall totals';
        overallDetails.appendChild(overallSummary);
        const overallList = document.createElement('ul');
        overallList.className = 'panel-list';
        const overallEntries = walletHistory.overall ?? [];
        if (!overallEntries.length) {
          const empty = document.createElement('li');
          empty.className = 'muted';
          empty.textContent = 'No overall history yet.';
          overallList.appendChild(empty);
        } else {
          overallEntries.forEach((entry) => {
            const item = document.createElement('li');
            const label = entry.timestamp
              ? new Date(entry.timestamp).toLocaleString()
              : 'Unknown time';
            item.innerHTML = `
              <div class="queue-row">
                <span class="queue-name">${label}</span>
                <span class="queue-meta">${formatIsk(entry.total)} ISK</span>
              </div>
            `;
            overallList.appendChild(item);
          });
        }
        overallDetails.appendChild(overallList);
        historyWrapper.appendChild(overallDetails);

        const historyCharacters = walletHistory.characters ?? {};
        Object.entries(historyCharacters).forEach(([characterName, entries]) => {
          const details = document.createElement('details');
          details.className = 'admin-history-card';
          const summary = document.createElement('summary');
          summary.textContent = characterName;
          details.appendChild(summary);
          const list = document.createElement('ul');
          list.className = 'panel-list';
          if (!entries.length) {
            const empty = document.createElement('li');
            empty.className = 'muted';
            empty.textContent = 'No history yet.';
            list.appendChild(empty);
          } else {
            entries.forEach((entry) => {
              const item = document.createElement('li');
              const label = entry.timestamp
                ? new Date(entry.timestamp).toLocaleString()
                : 'Unknown time';
              item.innerHTML = `
                <div class="queue-row">
                  <span class="queue-name">${label}</span>
                  <span class="queue-meta">${formatIsk(entry.balance)} ISK</span>
                </div>
              `;
              list.appendChild(item);
            });
          }
          details.appendChild(list);
          historyWrapper.appendChild(details);
        });
      }
      historyCard.appendChild(historyWrapper);
      content.appendChild(historyCard);
    }

    details.appendChild(content);
    featureGrid.appendChild(details);
  });

  wrapper.appendChild(featureGrid);

  const settingsTab = document.createElement('button');
  settingsTab.className = 'admin-settings-tab';
  settingsTab.type = 'button';
  settingsTab.textContent = 'Settings';
  settingsTab.addEventListener('click', () => {
    state.admin.settingsOpen = true;
    renderAdminModule();
  });
  wrapper.appendChild(settingsTab);

  renderAdminSettingsPanel(wrapper);
  mainContent.appendChild(wrapper);
}

function renderModulePage(moduleName) {
  if (!state.account) {
    renderLanding();
    return;
  }
  if (moduleName === 'landing') {
    renderLanding();
    return;
  }
  if (moduleName === 'home') {
    renderHome();
    return;
  }
  if (moduleName === 'characters') {
    renderCharactersModule();
    return;
  }
  if (moduleName === 'admin') {
    renderAdminModule();
    return;
  }
  if (moduleName === 'navigation') {
    renderNavigationModule();
    return;
  }
  const moduleData = state.modules.find((module) => module.name === moduleName);
  if (!moduleData) {
    renderHome();
    return;
  }
  if (moduleData.name !== 'home' && moduleData.name !== 'landing') {
    const wrapper = document.createElement('div');
    wrapper.className = 'module-wrapper';
    const settingsButton = createModuleSettingsButton(moduleData);
    if (settingsButton) {
      wrapper.appendChild(settingsButton);
    }
    const iframe = document.createElement('iframe');
    iframe.src = `/modules/${moduleName}/${moduleData.mainPage}`;
    iframe.style.width = '100%';
    iframe.style.height = '80vh';
    iframe.style.border = 'none';
    mainContent.innerHTML = '';
    wrapper.appendChild(iframe);
    mainContent.appendChild(wrapper);
    return;
  }
  renderHome();
}

function renderNavigationModule() {
  mainContent.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  title.textContent = 'Navigation Menu Module';
  const description = document.createElement('p');
  description.textContent =
    'Hover the top menu to reveal dropdowns. Modules can register their own pages.';
  card.appendChild(title);
  card.appendChild(description);

  const list = document.createElement('ul');
  list.className = 'nav-list';
  state.modules.forEach((module) => {
    const item = document.createElement('li');
    item.textContent = `${module.displayName} (${module.name})`;
    list.appendChild(item);
  });
  card.appendChild(list);
  mainContent.appendChild(card);
}

function createModuleSettingsButton(moduleData) {
  if (!moduleData?.adminSettings || !state.account?.isAdmin) {
    return null;
  }
  const button = document.createElement('button');
  button.className = 'module-settings-tab';
  button.type = 'button';
  button.textContent = '⚙ Settings';
  button.title = 'Module settings';
  button.addEventListener('click', () => openModuleSettings(moduleData));
  return button;
}

function openModuleSettings(moduleData) {
  if (!socket || !moduleData) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  socket.emit(
    'module:settings:request',
    { token, moduleName: moduleData.name },
    (response) => {
      if (response?.error) {
        state.settingsModal = null;
        renderSettingsModal();
        return;
      }
      state.settingsModal = response;
      renderSettingsModal();
    }
  );
}

function closeSettingsModal() {
  state.settingsModal = null;
  renderSettingsModal();
}

function renderSettingsModal() {
  const existing = document.querySelector('.modal-overlay');
  if (existing) {
    existing.remove();
  }
  if (!state.settingsModal) {
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeSettingsModal();
    }
  });

  const modal = document.createElement('div');
  modal.className = 'modal-card';

  const title = document.createElement('h3');
  title.textContent = state.settingsModal.adminSettings?.title ?? 'Module Settings';
  modal.appendChild(title);

  const fields = state.settingsModal.adminSettings?.fields ?? [];
  fields.forEach((field) => {
    const row = document.createElement('div');
    row.className = 'modal-field';
    const label = document.createElement('label');
    label.textContent = field.label ?? field.id ?? 'Setting';
    row.appendChild(label);

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      (field.options ?? []).forEach((option) => {
        const optionEl = document.createElement('option');
        optionEl.value = option;
        optionEl.textContent = option;
        input.appendChild(optionEl);
      });
      input.value = state.settingsModal.settings?.[field.id] ?? field.default ?? '';
    } else if (field.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked =
        state.settingsModal.settings?.[field.id] ?? field.default ?? false;
    } else if (field.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.value = state.settingsModal.settings?.[field.id] ?? field.default ?? '';
    } else if (field.type === 'duration') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = state.settingsModal.settings?.[field.id] ?? field.default ?? '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = state.settingsModal.settings?.[field.id] ?? field.default ?? '';
    }
    input.dataset.fieldId = field.id;
    input.dataset.fieldType = field.type ?? 'text';
    if (field.type === 'duration') {
      const summary = document.createElement('p');
      summary.className = 'duration-summary';
      summary.textContent = getDurationSummary(input.value);
      input.addEventListener('input', () => {
        summary.textContent = getDurationSummary(input.value);
      });
      row.appendChild(summary);
    }
    row.appendChild(input);

    if (field.help) {
      const help = document.createElement('p');
      help.className = 'modal-help';
      help.textContent = field.help;
      row.appendChild(help);
    }
    modal.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelButton = document.createElement('button');
  cancelButton.className = 'button secondary';
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', closeSettingsModal);

  const saveButton = document.createElement('button');
  saveButton.className = 'button';
  saveButton.type = 'button';
  saveButton.textContent = 'Save settings';
  saveButton.addEventListener('click', () => {
    const token = localStorage.getItem('fineauth_token');
    const nextSettings = {};
    modal.querySelectorAll('[data-field-id]').forEach((inputEl) => {
      const fieldId = inputEl.dataset.fieldId;
      const fieldType = inputEl.dataset.fieldType;
      if (fieldType === 'toggle') {
        nextSettings[fieldId] = inputEl.checked;
      } else {
        nextSettings[fieldId] = inputEl.value;
      }
    });
    socket.emit(
      'module:settings:update',
      {
        token,
        moduleName: state.settingsModal.moduleName,
        settings: nextSettings
      },
      (response) => {
        if (response?.ok) {
          closeSettingsModal();
          return;
        }
        closeSettingsModal();
      }
    );
  });

  actions.appendChild(cancelButton);
  actions.appendChild(saveButton);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function navigate() {
  if (!state.account) {
    renderLanding();
    if (window.location.hash !== '#/module/landing') {
      window.location.hash = '#/module/landing';
    }
    return;
  }
  const hash = window.location.hash || `#/module/${getDefaultModule()}`;
  const parts = hash.replace('#/', '').split('/');
  if (parts[0] === 'module' && parts[1]) {
    if (parts[1] === 'landing') {
      window.location.hash = `#/module/${getDefaultModule()}`;
      return;
    }
    renderModulePage(parts[1]);
  } else {
    renderModulePage(getDefaultModule());
  }
}

function handleEsiLogin() {
  if (!socket || !socket.connected) {
    state.loginError = 'Socket is not connected. Try again shortly.';
    renderLanding();
    return;
  }
  socket.emit('esi:login', null, (response) => {
    if (response?.url) {
      window.location.href = response.url;
      return;
    }
    state.loginError = response?.error ?? 'Failed to start ESI login.';
    renderLanding();
  });
}

function handleAddCharacter() {
  if (!socket || !socket.connected) {
    state.charactersError = 'Socket is not connected. Try again shortly.';
    renderCharactersModule();
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.charactersError = null;
  socket.emit('esi:login', { mode: 'add-character', token }, (response) => {
    if (response?.url) {
      window.location.href = response.url;
      return;
    }
    state.charactersError = response?.error ?? 'Failed to start character login.';
    if (window.location.hash === '#/module/characters') {
      renderCharactersModule();
      return;
    }
    renderHome();
  });
}

function handleRefreshCharacters() {
  if (!socket || !socket.connected) {
    state.charactersError = 'Socket is not connected. Try again shortly.';
    renderCharactersModule();
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  state.charactersError = null;
  state.charactersRefreshing = true;
  renderCharactersModule();
  socket.emit('characters:refresh', { token }, (response) => {
    state.charactersRefreshing = false;
    if (response?.error) {
      state.charactersError = response.error;
    } else if (response?.characters) {
      state.account = {
        ...state.account,
        characters: response.characters
      };
    }
    if (window.location.hash === '#/module/characters') {
      renderCharactersModule();
    } else {
      renderHome();
    }
  });
}

function handleLogout() {
  const token = localStorage.getItem('fineauth_token');
  if (socket && token) {
    socket.emit('session:logout', { token });
  }
  localStorage.removeItem('fineauth_token');
  state.account = null;
  state.loginError = null;
  state.charactersError = null;
  state.settingsModal = null;
  renderSettingsModal();
  renderNav();
  navigate();
  renderFooter();
}

function requestSession() {
  if (!socket) {
    return;
  }
  const token = localStorage.getItem('fineauth_token');
  socket.emit('session:request', { token }, (response) => {
    if (response?.account) {
      state.account = response.account;
      state.loginError = null;
    } else {
      state.account = null;
      if (response?.error) {
        localStorage.removeItem('fineauth_token');
      }
    }
    renderNav();
    navigate();
    renderFooter();
  });
}

function renderFooter() {
  if (!footer) {
    return;
  }
  const footerModule = state.modules.find(
    (module) => module.config?.region === 'footer' || module.name === 'footer'
  );
  if (!footerModule) {
    footer.style.display = 'none';
    footer.innerHTML = '';
    return;
  }
  footer.style.display = 'block';
  const status = state.esiStatus ?? {
    status: 'unknown',
    players: null,
    lastUpdated: null,
    error: null
  };
  const statusText =
    status.status === 'online'
      ? 'Online'
      : status.status === 'unavailable'
        ? 'Unavailable'
        : 'Unknown';
  const playersText =
    typeof status.players === 'number' ? status.players.toLocaleString() : 'N/A';
  footer.innerHTML = `
    <div class="footer-inner">
      <div class="footer-status">
        <span class="footer-label">ESI Status:</span>
        <span>${statusText}</span>
      </div>
      <div class="footer-status">
        <span class="footer-label">Tranquility Players:</span>
        <span>${playersText}</span>
      </div>
    </div>
  `;
}

function setupSocket() {
  socket = io();
  socket.on('connect', () => {
    state.socketConnected = true;
    requestSession();
    socket.emit('esi:status:request', null, (status) => {
      if (status) {
        state.esiStatus = status;
        renderNav();
        renderFooter();
      }
    });
    navigate();
  });
  socket.on('disconnect', () => {
    state.socketConnected = false;
    stopQueueTicker();
    navigate();
  });
  socket.on('esi:queue', (queue) => {
    if (Array.isArray(queue)) {
      state.esiQueue = queue;
      state.esiQueueMeta = { queueRunSeconds: 12, updatedAt: null };
    } else {
      state.esiQueue = queue?.items ?? [];
      state.esiQueueMeta = {
        queueRunSeconds: queue?.queueRunSeconds ?? 12,
        updatedAt: queue?.updatedAt ?? null
      };
    }
    renderNav();
    const hash = window.location.hash;
    if (hash === '#/module/home') {
      renderHome();
    }
    if (hash === '#/module/characters') {
      renderCharactersModule();
    }
    if (state.esiQueue.length) {
      startQueueTicker();
    } else {
      stopQueueTicker();
    }
  });
  socket.on('modules:update', (modules) => {
    state.modules = modules;
    renderNav();
    const currentHash = window.location.hash;
    const moduleName = currentHash.split('/')[2];
    if (moduleName && !modules.find((module) => module.name === moduleName)) {
      window.location.hash = `#/module/${getDefaultModule()}`;
    }
    if (moduleName) {
      renderModulePage(moduleName);
    }
    renderFooter();
  });
  socket.on('esi:status', (status) => {
    state.esiStatus = status;
    renderNav();
    renderFooter();
  });
  socket.on('permissions:updated', () => {
    requestSession();
  });
}

window.addEventListener('hashchange', navigate);
setupSocket();

if (!window.location.hash) {
  window.location.hash = `#/module/${getDefaultModule()}`;
}
