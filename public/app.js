const mainContent = document.getElementById('main-content');
const nav = document.getElementById('top-nav');

const state = {
  modules: [],
  account: null,
  esiQueue: [],
  socketConnected: false,
  accounts: [],
  loginError: null,
  accountsError: null
};

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
  }
};

function getDefaultModule() {
  if (!state.account) {
    return 'landing';
  }
  return state.account.type === 'static' ? 'accounts' : 'home';
}

function renderNav() {
  nav.innerHTML = '';
  if (!state.account) {
    nav.style.display = 'none';
    return;
  }
  nav.style.display = 'block';
  const list = document.createElement('ul');
  list.className = 'nav-list';

  const moduleItems = state.modules.filter((module) => {
    if (!module.mainPage || module.name === 'landing') {
      return false;
    }
    if (module.name === 'accounts' && state.account.type !== 'static') {
      return false;
    }
    return true;
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

  nav.appendChild(list);
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
  text.textContent = 'Authenticate your alliance and manage EVE Online access with confidence.';

  const form = document.createElement('form');
  form.className = 'login-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = form.querySelector('#static-username').value.trim();
    const password = form.querySelector('#static-password').value;
    handleAdminLogin(username, password);
  });

  const usernameLabel = document.createElement('label');
  usernameLabel.textContent = 'Static Admin Username';
  usernameLabel.setAttribute('for', 'static-username');
  const usernameInput = document.createElement('input');
  usernameInput.id = 'static-username';
  usernameInput.name = 'username';
  usernameInput.type = 'text';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;

  const passwordLabel = document.createElement('label');
  passwordLabel.textContent = 'Static Admin Password';
  passwordLabel.setAttribute('for', 'static-password');
  const passwordInput = document.createElement('input');
  passwordInput.id = 'static-password';
  passwordInput.name = 'password';
  passwordInput.type = 'password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.required = true;

  const adminButton = document.createElement('button');
  adminButton.className = 'button';
  adminButton.type = 'submit';
  adminButton.textContent = 'Login with Static Admin';

  form.appendChild(usernameLabel);
  form.appendChild(usernameInput);
  form.appendChild(passwordLabel);
  form.appendChild(passwordInput);
  form.appendChild(adminButton);

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
  card.appendChild(form);
  card.appendChild(buttonGroup);
  container.appendChild(card);
  mainContent.appendChild(container);
}

function renderHome() {
  mainContent.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h2');
  title.textContent = 'FineAuth Home';
  card.appendChild(title);

  const status = document.createElement('div');
  status.className = 'status-line';
  status.innerHTML = `
    <span>Socket.io: ${state.socketConnected ? 'Connected' : 'Disconnected'}</span>
    <span>Account: ${state.account ? state.account.name : 'Not signed in'}</span>
  `;
  card.appendChild(status);

  const helperInfo = document.createElement('p');
  helperInfo.textContent = 'Helpers for grid-aligned boxes, content order, and hover tooltips:';
  card.appendChild(helperInfo);

  const grid = helpers.createGridContainer([
    helpers.createBox({
      title: 'Grid Align',
      body: 'Use helper-grid for responsive layouts.',
      tooltip: 'Grid boxes auto-flow to the available space.'
    }),
    helpers.createBox({
      title: 'Content Margins',
      body: 'Apply consistent padding/margins with card + helper-box.',
      tooltip: 'Spacing controlled in styles.css.'
    }),
    helpers.createBox({
      title: 'Hover Events',
      body: 'Hover over boxes for tooltips that track the cursor.',
      tooltip: 'Tooltips follow your mouse position.'
    })
  ]);
  card.appendChild(grid);

  const queueTitle = document.createElement('h3');
  queueTitle.textContent = 'ESI Queue';
  card.appendChild(queueTitle);

  const queueBlock = document.createElement('div');
  queueBlock.className = 'code-block';
  queueBlock.textContent = state.esiQueue.length
    ? JSON.stringify(state.esiQueue, null, 2)
    : 'No ESI tasks queued.';
  card.appendChild(queueBlock);

  mainContent.appendChild(card);
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
  if (moduleName === 'accounts') {
    renderAccountManagement();
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
  if (!moduleData.builtIn) {
    const iframe = document.createElement('iframe');
    iframe.src = `/modules/${moduleName}/${moduleData.mainPage}`;
    iframe.style.width = '100%';
    iframe.style.height = '80vh';
    iframe.style.border = 'none';
    mainContent.innerHTML = '';
    mainContent.appendChild(iframe);
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

function renderAccountManagement() {
  if (!state.account || state.account.type !== 'static') {
    renderHome();
    return;
  }
  mainContent.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h2');
  title.textContent = 'Account Management';
  card.appendChild(title);

  const description = document.createElement('p');
  description.textContent =
    'Delete accounts when needed. You cannot delete the account you are currently using.';
  card.appendChild(description);

  if (state.accountsError) {
    const errorText = document.createElement('p');
    errorText.className = 'error-text';
    errorText.textContent = state.accountsError;
    card.appendChild(errorText);
  }

  const list = document.createElement('div');
  list.className = 'account-list';

  if (!state.accounts.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No accounts found.';
    list.appendChild(empty);
  } else {
    state.accounts.forEach((account) => {
      const row = document.createElement('div');
      row.className = 'account-row';

      const info = document.createElement('div');
      info.className = 'account-info';
      info.innerHTML = `
        <strong>${account.name}</strong>
        <span class="account-meta">${account.type}</span>
        <span class="account-meta">${account.createdAt}</span>
      `;

      const actions = document.createElement('div');
      actions.className = 'account-actions';
      const deleteButton = document.createElement('button');
      deleteButton.className = 'button secondary';
      deleteButton.textContent =
        account.id === state.account.id ? 'Current Account' : 'Delete';
      deleteButton.disabled = account.id === state.account.id;
      deleteButton.addEventListener('click', () => deleteAccountById(account.id));
      actions.appendChild(deleteButton);

      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  card.appendChild(list);
  mainContent.appendChild(card);
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

async function fetchModules() {
  const response = await fetch('/api/modules');
  const data = await response.json();
  state.modules = data.modules;
  renderNav();
  navigate();
}

async function checkSession() {
  const token = localStorage.getItem('fineauth_token');
  if (!token) {
    return;
  }
  const response = await fetch('/api/session', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.ok) {
    const data = await response.json();
    state.account = data.account;
    state.loginError = null;
    if (state.account.type === 'static') {
      await fetchAccounts();
    }
  } else {
    localStorage.removeItem('fineauth_token');
    state.account = null;
  }
}

async function fetchAccounts() {
  const token = localStorage.getItem('fineauth_token');
  if (!token) {
    return;
  }
  const response = await fetch('/api/accounts', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.ok) {
    const data = await response.json();
    state.accounts = data.accounts;
    state.accountsError = null;
  } else {
    state.accountsError = 'Unable to load accounts.';
  }
}

async function deleteAccountById(accountId) {
  const token = localStorage.getItem('fineauth_token');
  if (!token) {
    return;
  }
  const response = await fetch(`/api/accounts/${accountId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.ok) {
    await fetchAccounts();
    renderAccountManagement();
  } else {
    state.accountsError = 'Failed to delete account.';
    renderAccountManagement();
  }
}

async function handleAdminLogin(username, password) {
  if (!username || !password) {
    state.loginError = 'Enter the static admin username and password.';
    renderLanding();
    return;
  }
  const response = await fetch('/api/login/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (response.ok) {
    const data = await response.json();
    localStorage.setItem('fineauth_token', data.token);
    await checkSession();
    window.location.hash = `#/module/${getDefaultModule()}`;
  } else {
    state.loginError = 'Static admin login failed.';
    renderLanding();
  }
}

async function handleEsiLogin() {
  window.location.href = '/api/esi/login';
}

function setupSocket() {
  const socket = io();
  socket.on('connect', () => {
    state.socketConnected = true;
    navigate();
  });
  socket.on('disconnect', () => {
    state.socketConnected = false;
    navigate();
  });
  socket.on('esi:queue', (queue) => {
    state.esiQueue = queue;
    if (window.location.hash === '#/module/home') {
      renderHome();
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
  });
}

window.addEventListener('hashchange', navigate);

await checkSession();
await fetchModules();
setupSocket();

window.location.hash = `#/module/${getDefaultModule()}`;
