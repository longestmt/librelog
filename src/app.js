import { openDB, getSetting, setSetting, putMany, importAllData } from './data/db.js';
import { setGoals } from './engine/goal-tracking.js';
import { DEFAULT_FOODS } from './data/seed-foods.js';
import { hapticLight } from './utils/haptics.js';
import { initAutoBackup, getAvailableBackups, getBackupData } from './data/auto-backup.js';
import { renderDiaryPage } from './pages/diary.js';
import { renderSearchPage } from './pages/search.js';
import { renderInsightsPage } from './pages/insights.js';
import { renderWeightPage } from './pages/weight.js';
import { renderRecipesPage } from './pages/recipes.js';
import { renderSettingsPage } from './pages/settings.js';
import { renderHistoryPage } from './pages/history.js';

// SVG Icons (Lucide-style)
const ICONS = {
  book: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  barchart: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>`,
  scan: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>`,
  settings: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  brand: `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5c0 1 .5 2 1.5 2S6 9 6 8V3"/><line x1="4.5" y1="10" x2="4.5" y2="21"/><path d="M20 3c-1.5 0-3 1.5-3 4s1.5 4 3 4"/><line x1="20" y1="11" x2="20" y2="21"/></svg>`,
  weight: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  recipe: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  ai: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/><circle cx="12" cy="15" r="2"/></svg>`,
};

const ROUTES = {
  diary: { component: renderDiaryPage, label: 'Diary', icon: ICONS.book, nav: true },
  search: { component: renderSearchPage, label: 'Search', icon: ICONS.search, nav: false },
  insights: { component: renderInsightsPage, label: 'Insights', icon: ICONS.barchart, nav: true },
  weight: { component: renderWeightPage, label: 'Weight', icon: ICONS.weight, nav: true },
  recipes: { component: renderRecipesPage, label: 'Recipes', icon: ICONS.recipe, nav: true },
  history: { component: renderHistoryPage, label: 'Meal History', icon: ICONS.book, nav: false },
  settings: { component: renderSettingsPage, label: 'Settings', icon: ICONS.settings, nav: true },
};

let currentRoute = 'diary';
let activePageCleanup = null;
let routeSequence = 0;

async function init() {
  try {
    await openDB();

    const isFirstRun = !(await getSetting('initialized'));

    if (isFirstRun) {
      // Seed default foods
      await putMany('foods', DEFAULT_FOODS);

      // Set default settings
      await setSetting('initialized', true);
      await setSetting('theme', 'compline');
      await setSetting('unit', 'metric');

      // Set default goals
      await setGoals({
        calorieTarget: 2000,
        proteinG: 150,
        carbG: 225,
        fatG: 65,
        fiberG: 30,
        sodiumMg: 2300,
      });
    }

    await applyTheme();
    renderShell();
    await handleRoute();

    // Start auto-backup scheduler (6-hour intervals)
    initAutoBackup().catch(err => console.warn('Auto-backup init failed:', err));

    // Listen for data loss events from auto-backup integrity check
    window.addEventListener('librelog:dataloss', (e) => {
      const msg = e.detail?.message || 'Possible data loss detected.';
      if (confirm(msg)) {
        const backups = getAvailableBackups();
        if (backups.length > 0) {
          const latest = backups[backups.length - 1];
          const data = getBackupData(latest.timestamp);
          if (data) {
            importAllData(data, false).then(() => window.location.reload());
          }
        }
      }
    });
  } catch (err) {
    console.error('Failed to initialize LibreLog:', err);
    document.body.innerHTML = '<p>Failed to initialize app. Please refresh.</p>';
  }
}

async function applyTheme() {
  let theme = (await getSetting('theme')) || 'compline';
  // Migrate old theme names
  const themeMap = { dark: 'compline', light: 'lauds', amoled: 'vigil' };
  if (themeMap[theme]) {
    theme = themeMap[theme];
    await setSetting('theme', theme);
  }
  if (theme === 'compline') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function renderShell() {
  document.body.innerHTML = `
    <div id="app" class="app">
      <a href="#main-content" class="sr-only skip-link">Skip to main content</a>
      <main id="main-content" class="page-container" tabindex="-1"></main>
      <nav class="bottom-nav" role="navigation" aria-label="Main navigation">
        <div class="navbar-brand" aria-hidden="true">
          <img src="/icon.svg" alt="" class="brand-logo" />
          <span class="brand-text">LibreLog</span>
        </div>
        ${Object.entries(ROUTES).filter(([, config]) => config.nav).map(([route, config]) => `
          <a href="#/${route}" class="nav-item ${route === currentRoute ? 'active' : ''}" data-route="${route}" role="link" aria-label="${config.label}" aria-current="${route === currentRoute ? 'page' : 'false'}">
            ${config.icon}
            <span class="nav-label">${config.label}</span>
          </a>
        `).join('')}
      </nav>
    </div>
  `;

  // Event delegation for nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const route = el.dataset.route;
      window.location.hash = `#/${route}`;
      hapticLight();
    });

    // Keyboard support: Enter and Space
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const route = el.dataset.route;
        window.location.hash = `#/${route}`;
        hapticLight();
      }
    });
  });
}

async function handleRoute() {
  const sequence = ++routeSequence;
  const hash = window.location.hash.slice(1) || '/diary';
  const [pathname, query] = hash.split('?');
  const route = pathname.slice(1) || 'diary';

  if (!ROUTES[route]) {
    window.location.hash = '#/diary';
    return;
  }

  currentRoute = route;

  // Update nav active state and aria-current
  document.querySelectorAll('.nav-item').forEach(el => {
    const isActive = el.dataset.route === route;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  // Render page
  if (typeof activePageCleanup === 'function') {
    try { activePageCleanup(); } catch (err) { console.warn('Page cleanup failed:', err); }
    activePageCleanup = null;
  }

  // Give each route its own main element. Async work from a previous page may
  // finish later, but can then only update its disconnected container.
  const previousContainer = document.getElementById('main-content');
  const container = document.createElement('main');
  container.id = 'main-content';
  container.className = 'page-container';
  container.tabIndex = -1;
  previousContainer.replaceWith(container);
  container.setAttribute('aria-label', ROUTES[route].label);
  document.title = `${ROUTES[route].label} · LibreLog`;

  try {
    const cleanup = await ROUTES[route].component(container, query);
    if (sequence !== routeSequence || !container.isConnected) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    if (typeof cleanup === 'function') activePageCleanup = cleanup;
    requestAnimationFrame(() => container.focus({ preventScroll: true }));
  } catch (err) {
    if (sequence !== routeSequence || !container.isConnected) return;
    console.error(`Error rendering ${route} page:`, err);
    container.innerHTML = `<div class="error-message"><p>Error loading page. Please refresh.</p></div>`;
  }
}

// Hash change listener
window.addEventListener('hashchange', handleRoute);

// Initialize app
document.addEventListener('DOMContentLoaded', init);

// Expose for testing/debugging
window.__librelog__ = window.__librelog__ || {};
window.__librelog__.app = { init, handleRoute, applyTheme };
