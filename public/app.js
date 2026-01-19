const mainContent = document.getElementById('main-content');
const nav = document.getElementById('top-nav');
const footer = document.getElementById('footer');

const state = {
  modules: [],
  account: null,
  esiQueue: [],
  socketConnected: false,
  loginError: null,
  esiStatus: null
};

let socket;

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
  return 'home';
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

  const actions = document.createElement('div');
  actions.className = 'nav-actions';
  const logoutButton = document.createElement('button');
  logoutButton.className = 'button secondary nav-button';
  logoutButton.type = 'button';
  logoutButton.textContent = 'Log out';
  logoutButton.addEventListener('click', handleLogout);
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
    <span>Role: ${state.account?.isAdmin ? 'Admin' : 'Member'}</span>
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

function handleLogout() {
  localStorage.removeItem('fineauth_token');
  state.account = null;
  state.loginError = null;
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
        renderFooter();
      }
    });
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
    renderFooter();
  });
  socket.on('esi:status', (status) => {
    state.esiStatus = status;
    renderFooter();
  });
  socket.on('permissions:updated', () => {
    requestSession();
  });
}

window.addEventListener('hashchange', navigate);
setupSocket();

window.location.hash = `#/module/${getDefaultModule()}`;
