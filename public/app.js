const mainContent = document.getElementById('main-content');
const nav = document.getElementById('top-nav');

const state = {
  modules: [],
  account: null,
  esiQueue: [],
  socketConnected: false
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

function renderNav() {
  nav.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'nav-list';

  const moduleItems = state.modules.filter((module) => module.mainPage);
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

  const buttonGroup = document.createElement('div');
  buttonGroup.className = 'button-group';

  const adminButton = document.createElement('button');
  adminButton.className = 'button';
  adminButton.textContent = 'Login as Admin';
  adminButton.addEventListener('click', handleAdminLogin);

  const esiButton = document.createElement('button');
  esiButton.className = 'button secondary';
  esiButton.textContent = 'Sign in with EVE Online ESI';
  esiButton.addEventListener('click', handleEsiLogin);

  buttonGroup.appendChild(adminButton);
  buttonGroup.appendChild(esiButton);

  card.appendChild(logo);
  card.appendChild(title);
  card.appendChild(text);
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
  if (moduleName === 'landing') {
    renderLanding();
    return;
  }
  if (moduleName === 'home') {
    renderHome();
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

function navigate() {
  const hash = window.location.hash || '#/module/landing';
  const parts = hash.replace('#/', '').split('/');
  if (parts[0] === 'module' && parts[1]) {
    renderModulePage(parts[1]);
  } else {
    renderHome();
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
  } else {
    localStorage.removeItem('fineauth_token');
  }
}

async function handleAdminLogin() {
  const username = prompt('Admin username');
  const password = prompt('Admin password');
  if (!username || !password) {
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
    window.location.hash = '#/module/home';
  } else {
    alert('Admin login failed');
  }
}

async function handleEsiLogin() {
  const mainCharacterName = prompt('Main character name');
  if (!mainCharacterName) {
    return;
  }
  const response = await fetch('/api/login/esi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mainCharacterName })
  });
  if (response.ok) {
    const data = await response.json();
    localStorage.setItem('fineauth_token', data.token);
    await checkSession();
    window.location.hash = '#/module/home';
  } else {
    alert('ESI login failed');
  }
}

function setupSocket() {
  const socket = io();
  socket.on('connect', () => {
    state.socketConnected = true;
    renderHome();
  });
  socket.on('disconnect', () => {
    state.socketConnected = false;
    renderHome();
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
      window.location.hash = '#/module/home';
    }
  });
}

window.addEventListener('hashchange', navigate);

await checkSession();
await fetchModules();
setupSocket();

if (state.account) {
  window.location.hash = '#/module/home';
} else {
  window.location.hash = '#/module/landing';
}
