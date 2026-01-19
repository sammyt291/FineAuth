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
    expandedFeatures: new Set(['mail']),
    expandedSettingGroups: new Set(['mail']),
    settingsOpen: false,
    loadingAccounts: false,
    loadingSettings: false
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

function ensureAdminData() {
  if (!state.admin.accounts.length && !state.admin.loadingAccounts) {
    requestAdminAccounts();
  }
  if (!state.admin.settings && !state.admin.loadingSettings) {
    requestAdminSettings();
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
    details.open =
      state.admin.expandedSettingGroups.has(group.key) ||
      (!state.admin.expandedSettingGroups.size && index === 0);
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
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value =
          state.admin.settings?.settings?.[field.id] ?? field.default ?? '';
      }
      input.dataset.fieldId = field.id;
      input.dataset.fieldType = field.type ?? 'text';
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
    details.open =
      state.admin.expandedFeatures.has(feature.key) ||
      (!state.admin.expandedFeatures.size && index === 0);
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
      const searchRow = document.createElement('div');
      searchRow.className = 'admin-search-row';
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.placeholder = 'Search by title...';
      const contentInput = document.createElement('input');
      contentInput.type = 'text';
      contentInput.placeholder = 'Search by content...';
      searchRow.appendChild(titleInput);
      searchRow.appendChild(contentInput);
      content.appendChild(searchRow);

      const list = document.createElement('div');
      list.className = 'admin-empty-state';
      list.textContent = 'No mail loaded for the selected account yet.';
      content.appendChild(list);
    }

    if (feature.key === 'skills') {
      const skillsCard = document.createElement('div');
      skillsCard.className = 'card';
      const title = document.createElement('h4');
      title.textContent = 'Skills Overview';
      skillsCard.appendChild(title);
      const skillsList = document.createElement('ul');
      skillsList.className = 'panel-list';
      const emptySkill = document.createElement('li');
      emptySkill.className = 'muted';
      emptySkill.textContent = 'No skill data loaded for the selected account.';
      skillsList.appendChild(emptySkill);
      skillsCard.appendChild(skillsList);
      content.appendChild(skillsCard);

      const queueCard = document.createElement('div');
      queueCard.className = 'card';
      const queueTitle = document.createElement('h4');
      queueTitle.textContent = 'Training Queue';
      queueCard.appendChild(queueTitle);
      const queueList = document.createElement('ul');
      queueList.className = 'panel-list';
      const emptyQueue = document.createElement('li');
      emptyQueue.className = 'muted';
      emptyQueue.textContent = 'No active training queue entries.';
      queueList.appendChild(emptyQueue);
      queueCard.appendChild(queueList);
      content.appendChild(queueCard);

      const walletCard = document.createElement('div');
      walletCard.className = 'card';
      const walletTitle = document.createElement('h4');
      walletTitle.textContent = 'ISK Snapshot';
      walletCard.appendChild(walletTitle);
      const walletValue = document.createElement('p');
      walletValue.className = 'muted';
      walletValue.textContent = 'ISK totals will appear once wallet data syncs.';
      walletCard.appendChild(walletValue);
      content.appendChild(walletCard);
    }

    if (feature.key === 'history') {
      const historyCard = document.createElement('div');
      historyCard.className = 'card';
      const title = document.createElement('h4');
      title.textContent = 'ISK History';
      historyCard.appendChild(title);
      const summaryText = document.createElement('p');
      summaryText.className = 'muted';
      summaryText.textContent =
        'No ISK history data available yet for the selected account.';
      historyCard.appendChild(summaryText);
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
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = state.settingsModal.settings?.[field.id] ?? field.default ?? '';
    }
    input.dataset.fieldId = field.id;
    input.dataset.fieldType = field.type ?? 'text';
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

window.location.hash = `#/module/${getDefaultModule()}`;
