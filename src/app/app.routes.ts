import { Routes } from '@angular/router';

/**
 * Route data fields used for SEO + accessibility:
 *
 *   `label`            — visible label, also used in breadcrumbs and the
 *                         "Loaded {label}" announcement to screen readers.
 *   `seoTitle`         — short page title (~50–60 chars). Rendered as
 *                         `${seoTitle} | ng-package-compat`.
 *   `seoDescription`   — under 160 chars; used for <meta name="description">
 *                         and the OG / Twitter description.
 *   `seoKeywords`      — array; comma-joined into <meta name="keywords">.
 *                         Empty arrays are allowed (clears the tag).
 *   `seoNoIndex`       — true for personal / signed-in / auth-callback
 *                         pages we don't want in search results.
 *   `seoImage`         — optional per-route OG image override. Defaults to
 *                         the site OG card.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/search/search-page.component').then((m) => m.SearchPageComponent),
    title: 'Angular compatibility for any npm package',
    data: {
      label: 'Search',
      seoTitle: 'Angular compatibility for any npm package',
      seoDescription:
        'Free open-source tool to check any npm package against any Angular version. ' +
        'Inspect peer dependencies, weekly downloads, bundle size, release timeline ' +
        'and known security advisories — all without leaving the page.',
      seoKeywords: [
        'angular', 'npm', 'package', 'compatibility', 'peer dependency',
        'search', 'ng-package-compat', 'angular 21', 'open source'
      ]
    }
  },
  {
    path: 'compare',
    loadComponent: () =>
      import('./pages/compare/compare-page.component').then((m) => m.ComparePageComponent),
    title: 'Compare npm packages side-by-side',
    data: {
      label: 'Compare',
      seoTitle: 'Compare npm packages side-by-side',
      seoDescription:
        'Compare multiple npm packages side-by-side. See their Angular support matrix, ' +
        'bundle sizes, download trends and release history at a glance.',
      seoKeywords: ['compare', 'npm packages', 'angular', 'bundle size', 'downloads', 'side by side']
    }
  },
  {
    path: 'history',
    loadComponent: () =>
      import('./pages/history/history-page.component').then((m) => m.HistoryPageComponent),
    title: 'Recent searches',
    data: {
      label: 'History',
      seoTitle: 'Recent package searches',
      seoDescription:
        'Your recent ng-package-compat searches, kept locally in your browser.',
      seoKeywords: ['recent searches', 'history', 'npm packages'],
      seoNoIndex: true
    }
  },
  {
    path: 'upgrade/wizard',
    loadComponent: () =>
      import('./pages/upgrade-wizard/upgrade-wizard.component').then(
        (m) => m.UpgradeWizardComponent
      ),
    title: 'Guided Angular upgrade wizard',
    data: {
      label: 'Wizard',
      seoTitle: 'Guided Angular upgrade wizard',
      seoDescription:
        'A step-by-step Angular upgrade flow that walks you through review, ' +
        'risk assessment, and PR creation one decision at a time.',
      seoKeywords: ['angular upgrade', 'wizard', 'guided', 'step by step', 'migration']
    }
  },
  {
    path: 'upgrade',
    loadComponent: () =>
      import('./pages/upgrade/upgrade-page.component').then((m) => m.UpgradePageComponent),
    title: 'Angular upgrade & dependency health check',
    data: {
      label: 'Upgrade',
      seoTitle: 'Angular upgrade & dependency health check',
      seoDescription:
        'Drop your package.json to find outdated libraries, flag breaking changes ahead ' +
        'of your next Angular upgrade, and get a single copyable `ng update` command for ' +
        'your entire project.',
      seoKeywords: [
        'angular upgrade', 'ng update', 'package.json analyzer', 'breaking change',
        'dependency health', 'library optimization', 'angular 17', 'angular 18',
        'angular 19', 'angular 20', 'angular 21'
      ]
    }
  },
  {
    path: 'dependencies/:pkg/:version',
    loadComponent: () =>
      import('./pages/dependencies/dependencies-page.component').then(
        (m) => m.DependenciesPageComponent
      ),
    title: 'Package dependencies & peers',
    data: {
      label: 'Dependencies',
      seoTitle: 'Package dependencies & peers',
      seoDescription:
        'Inspect the dependencies and peer dependencies declared by a specific version ' +
        'of an npm package, including Angular peer ranges.',
      seoKeywords: ['dependencies', 'peer dependencies', 'npm', 'angular', 'compatibility']
    }
  },
  {
    path: 'diff/:pkg',
    loadComponent: () =>
      import('./pages/diff/diff-page.component').then((m) => m.DiffPageComponent),
    title: 'Compare two versions of a package',
    data: {
      label: 'Diff',
      seoTitle: 'Compare two versions of a package',
      seoDescription:
        'See exactly what changed in dependencies, peer dependencies and deprecations ' +
        'between any two published versions of an npm package.',
      seoKeywords: ['version diff', 'release changes', 'peer dependency changes', 'changelog']
    }
  },
  {
    path: 'favorites',
    loadComponent: () =>
      import('./pages/favorites/favorites-page.component').then(
        (m) => m.FavoritesPageComponent
      ),
    title: 'Starred packages dashboard',
    data: {
      label: 'Favorites',
      seoTitle: 'Starred packages dashboard',
      seoDescription:
        'Your starred npm packages in one place, with live Angular compatibility, ' +
        'security advisories and release activity at a glance.',
      seoKeywords: ['favorites', 'watchlist', 'npm packages', 'dashboard'],
      seoNoIndex: true
    }
  },
  {
    path: 'about',
    loadComponent: () =>
      import('./pages/about/about-page.component').then((m) => m.AboutPageComponent),
    title: 'About & methodology',
    data: {
      label: 'About',
      seoTitle: 'About & methodology',
      seoDescription:
        'How ng-package-compat detects Angular compatibility, the data sources we trust, ' +
        'and the privacy model behind this tool.',
      seoKeywords: ['about', 'methodology', 'data sources', 'open source', 'privacy']
    }
  },
  {
    path: 'privacy',
    loadComponent: () =>
      import('./pages/privacy/privacy-page.component').then((m) => m.PrivacyPageComponent),
    title: 'Privacy policy',
    data: {
      label: 'Privacy',
      seoTitle: 'Privacy policy',
      seoDescription:
        'What ng-package-compat collects, where it lives, which third parties handle data, ' +
        'and how to delete everything we have on you.',
      seoKeywords: ['privacy', 'data deletion', 'gdpr', 'supabase', 'sentry']
    }
  },
  {
    path: 'sign-in',
    loadComponent: () =>
      import('./pages/sign-in/sign-in-page.component').then((m) => m.SignInPageComponent),
    title: 'Sign in',
    data: {
      label: 'Sign in',
      seoTitle: 'Sign in to ng-package-compat',
      seoDescription:
        'Sign in with GitHub, GitLab, BitBucket, Microsoft Azure, or LinkedIn to scan ' +
        'your Angular projects automatically.',
      seoNoIndex: true
    }
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./pages/auth-callback/auth-callback-page.component').then(
        (m) => m.AuthCallbackPageComponent
      ),
    title: 'Signing in…',
    data: {
      label: 'Auth',
      seoTitle: 'Signing in',
      seoDescription: 'Completing the OAuth handshake with your code-host provider.',
      seoNoIndex: true
    }
  },
  {
    path: 'projects',
    loadComponent: () =>
      import('./pages/projects/projects-page.component').then((m) => m.ProjectsPageComponent),
    title: 'Your projects',
    data: {
      label: 'Projects',
      seoTitle: 'Your scanned projects',
      seoDescription:
        'Repositories you have linked from GitHub, GitLab, BitBucket, or Azure DevOps. ' +
        'Pick one to scan its package.json for Angular compatibility issues.',
      seoNoIndex: true
    }
  },
  // /workspace was the old LinkedIn / Gmail identity-hub landing. We dropped
  // those flows in favour of direct OAuth, so the route just redirects users
  // who follow an old link straight to /projects.
  { path: 'workspace', redirectTo: 'projects' },
  {
    path: 'snapshot-diff',
    loadComponent: () =>
      import('./pages/snapshot-diff/snapshot-diff-page.component').then(
        (m) => m.SnapshotDiffPageComponent
      ),
    title: 'Compare two saved snapshots',
    data: {
      label: 'Snapshot diff',
      seoTitle: 'Compare two saved snapshots',
      seoDescription:
        'Time-travel diff between any two captured project snapshots. See which packages ' +
        'were added, removed, or changed since your last upgrade.',
      seoNoIndex: true
    }
  },
  { path: '**', redirectTo: '' }
];
