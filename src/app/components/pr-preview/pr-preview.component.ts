import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { TranslocoModule } from '@jsverse/transloco';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, of, switchMap } from 'rxjs';
import {
  CompatibilityReport,
  ParsedPackageJson
} from '../../models/npm-package.model';
import {
  PrArtifacts,
  PrGeneratorService
} from '../../services/pr-generator.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';
import { ToastService } from '../../services/toast.service';
import { ProjectScannerService } from '../../services/project-scanner.service';
import { NormalizedRepo } from '../../services/provider-repo.service';
import { AuthProvider } from '../../services/auth.service';
import {
  ExistingPr,
  ExistingPrLookupService
} from '../../services/existing-pr-lookup.service';

/**
 * Provider this component currently knows how to open a PR/MR against.
 * GitHub, GitLab, and Bitbucket are all end-to-end (list repos → load
 * branches → look up existing PRs/MRs → push the patch and open the
 * PR/MR). Azure is scan-only today (no automated PR endpoint yet) and
 * falls back to the generic "sign in" prompt.
 */
type PushableProvider = 'github' | 'gitlab' | 'bitbucket';

/**
 * Card shown on the upgrade page that builds a PR-style patch from the report
 * and lets the user open the PR with a single click.
 *
 * Three input states, in order of preference:
 *
 * 1. **`activeRepo` is supplied** (the user reached /upgrade by clicking
 *    "Analyze" on /projects). We render the repo as a read-only badge,
 *    auto-fetch its branches, and submit goes straight to GitHub. Zero
 *    manual input required — this is the seamless "one-click PR" path.
 *
 * 2. **No `activeRepo` but the project scanner has scanned repos** (user
 *    signed in but came in via package.json drop). We show a dropdown of
 *    their scanned GitHub repos so they can pick one quickly.
 *
 * 3. **Nothing scanned** (anonymous user dropped a package.json). Free
 *    text input as a last-resort fallback, with format validation.
 */
@Component({
  selector: 'app-pr-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, TranslocoModule],
  template: `
    @if (report() && parsed()) {
      <section class="pr">
        <header>
          <h3>{{ 'pr.title' | transloco }}</h3>
          <p class="muted">{{ 'pr.lede' | transloco }}</p>
        </header>

        @if (artifacts(); as a) {
          @if (a.changedCount === 0) {
            <p class="empty">{{ 'pr.empty' | transloco }}</p>
          } @else {
            <div class="meta">
              <span>{{ 'pr.changedCount' | transloco: { count: a.changedCount } }}</span>
              <span aria-hidden="true">·</span>
              <code class="branch-pill">{{ a.branchName }}</code>
            </div>

            <details open>
              <summary>{{ 'pr.diff' | transloco }}</summary>
              <pre class="diff"><code>{{ a.unifiedDiff }}</code></pre>
              <button type="button" class="ghost" (click)="copy(a.unifiedDiff)">
                {{ 'pr.copyDiff' | transloco }}
              </button>
            </details>

            <details>
              <summary>{{ 'pr.body' | transloco }}</summary>
              <pre class="body"><code>{{ a.body }}</code></pre>
              <button type="button" class="ghost" (click)="copy(a.body)">
                {{ 'pr.copyBody' | transloco }}
              </button>
            </details>

            @if (canPush() && manualGitlabOnly()) {
              <!-- GitLab-only signed in + no scanned repos = no usable form.
                   Render a dedicated info card with two CTAs instead of a
                   form that's guaranteed to fail at submit time. -->
              <div class="manual-gitlab-only" role="status">
                <div class="mgo-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 8v4M12 16h.01"/>
                  </svg>
                </div>
                <div class="mgo-body">
                  <h4>{{ 'pr.manualGitlabOnly.title' | transloco }}</h4>
                  <p class="muted">{{ 'pr.manualGitlabOnly.body' | transloco }}</p>
                  <div class="mgo-actions">
                    <a routerLink="/projects" class="link-btn link-btn-strong">
                      {{ 'pr.manualGitlabOnly.scanGitlab' | transloco }}
                    </a>
                    <span aria-hidden="true">·</span>
                    <a routerLink="/sign-in" class="link-btn">
                      {{ 'pr.manualGitlabOnly.linkGitHub' | transloco }}
                    </a>
                  </div>
                </div>
              </div>
            } @else if (canPush()) {
              <form class="push" (submit)="open($event, a)" novalidate>
                @switch (mode()) {
                  @case ('active-repo') {
                    <!-- Path 1: zero-input mode. The active repo is shown as
                         a clean badge; branches auto-fetched. -->
                    @if (activeRepo(); as r) {
                      <div class="active-repo" role="group" [attr.aria-label]="'pr.activeRepo' | transloco">
                        <span class="active-repo-icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
                            <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 11-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
                          </svg>
                        </span>
                        <div class="active-repo-meta">
                          <span class="active-repo-label">{{ 'pr.activeRepo' | transloco }}</span>
                          <a
                            [href]="r.webUrl"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="active-repo-name"
                          >
                            {{ r.fullName }}
                            @if (r.isPrivate) {
                              <span class="private-badge" [attr.aria-label]="'pr.private' | transloco">{{ 'pr.private' | transloco }}</span>
                            }
                          </a>
                        </div>
                      </div>

                      <!-- Branch selector — adaptive: hide when there's only
                           one branch, dropdown when there are several. -->
                      @if (branchesLoading()) {
                        <div class="branch-row branch-loading" role="status">
                          <span class="dot" aria-hidden="true"></span>
                          {{ 'pr.loadingBranches' | transloco }}
                        </div>
                      } @else if (displayBranches().length > 1) {
                        <label class="field branch-row">
                          <span>{{ 'pr.baseBranch' | transloco }}</span>
                          <select
                            [ngModel]="baseBranch()"
                            (ngModelChange)="baseBranch.set($event)"
                            name="base"
                          >
                            @if (hasGroupedBranches()) {
                              <optgroup [label]="'pr.branchGroup.project' | transloco">
                                @for (b of projectBranches(); track b) {
                                  <option [value]="b">{{ b }}</option>
                                }
                              </optgroup>
                              <optgroup [label]="'pr.branchGroup.previousUpdates' | transloco">
                                @for (b of previousToolBranches(); track b) {
                                  <option [value]="b">{{ b }}</option>
                                }
                              </optgroup>
                            } @else {
                              @for (b of projectBranches(); track b) {
                                <option [value]="b">{{ b }}</option>
                              }
                            }
                          </select>
                        </label>
                      } @else if (displayBranches().length === 1) {
                        <div class="branch-row branch-single">
                          {{ 'pr.targetingBranch' | transloco }}
                          <code class="branch-pill">{{ displayBranches()[0] }}</code>
                        </div>
                      } @else {
                        <!-- Branch fetch failed — fall back to a text input
                             pre-filled with the default branch. -->
                        <label class="field branch-row">
                          <span>{{ 'pr.baseBranch' | transloco }}</span>
                          <input
                            type="text"
                            [ngModel]="baseBranch()"
                            (ngModelChange)="baseBranch.set($event)"
                            name="base"
                            placeholder="main"
                            autocomplete="off"
                            spellcheck="false"
                          />
                        </label>
                      }
                    }
                  }
                  @case ('dropdown') {
                    <!-- Path 2: pick from scanned repos. GitHub, GitLab, and
                         Bitbucket each get their own optgroup so the user
                         knows which provider their pick will go to. -->
                    <label class="field">
                      <span>{{ 'pr.repo' | transloco }}</span>
                      <select
                        [ngModel]="repoFullName()"
                        (ngModelChange)="repoFullName.set($event)"
                        name="repo"
                      >
                        <option value="" disabled>
                          {{ 'pr.selectRepo' | transloco }}
                        </option>
                        @if (githubRepos().length) {
                          <optgroup label="GitHub">
                            @for (repo of githubRepos(); track repo.id) {
                              <option [value]="repo.fullName">{{ repo.fullName }}</option>
                            }
                          </optgroup>
                        }
                        @if (gitlabRepos().length) {
                          <optgroup label="GitLab">
                            @for (repo of gitlabRepos(); track repo.id) {
                              <option [value]="repo.fullName">{{ repo.fullName }}</option>
                            }
                          </optgroup>
                        }
                        @if (bitbucketRepos().length) {
                          <optgroup label="Bitbucket">
                            @for (repo of bitbucketRepos(); track repo.id) {
                              <option [value]="repo.fullName">{{ repo.fullName }}</option>
                            }
                          </optgroup>
                        }
                      </select>
                      @if (canPushToGitHub() || canPushToBitbucket()) {
                        <!-- Manual entry accepts owner/repo (GitHub) and
                             workspace/repo_slug (Bitbucket) — both match
                             the same regex. GitLab is excluded because it
                             needs a numeric project id we can't ask the
                             user to type. Show the override only when at
                             least one type-able provider has a token. -->
                        <button
                          type="button"
                          class="link-btn"
                          (click)="manualOverride.set(true)"
                        >
                          {{ 'pr.typeManually' | transloco }}
                        </button>
                      }
                    </label>

                    <!-- Branch selector — reuses the same adaptive UI as
                         active-repo mode. Branches are auto-fetched when
                         the user picks a repo from the dropdown, via the
                         shared effectiveRepo signal effect. -->
                    @if (branchesLoading()) {
                      <div class="branch-row branch-loading" role="status">
                        <span class="dot" aria-hidden="true"></span>
                        {{ 'pr.loadingBranches' | transloco }}
                      </div>
                    } @else if (displayBranches().length > 1) {
                      <label class="field branch-row">
                        <span>{{ 'pr.baseBranch' | transloco }}</span>
                        <select
                          [ngModel]="baseBranch()"
                          (ngModelChange)="baseBranch.set($event)"
                          name="base"
                        >
                          @if (hasGroupedBranches()) {
                            <optgroup [label]="'pr.branchGroup.project' | transloco">
                              @for (b of projectBranches(); track b) {
                                <option [value]="b">{{ b }}</option>
                              }
                            </optgroup>
                            <optgroup [label]="'pr.branchGroup.previousUpdates' | transloco">
                              @for (b of previousToolBranches(); track b) {
                                <option [value]="b">{{ b }}</option>
                              }
                            </optgroup>
                          } @else {
                            @for (b of projectBranches(); track b) {
                              <option [value]="b">{{ b }}</option>
                            }
                          }
                        </select>
                      </label>
                    } @else if (displayBranches().length === 1) {
                      <div class="branch-row branch-single">
                        {{ 'pr.targetingBranch' | transloco }}
                        <code class="branch-pill">{{ displayBranches()[0] }}</code>
                      </div>
                    } @else {
                      <label class="field branch-row">
                        <span>{{ 'pr.baseBranch' | transloco }}</span>
                        <input
                          type="text"
                          [ngModel]="baseBranch()"
                          (ngModelChange)="baseBranch.set($event)"
                          name="base"
                          placeholder="main"
                          autocomplete="off"
                          spellcheck="false"
                        />
                      </label>
                    }
                  }
                  @case ('manual') {
                    <!-- Path 3: free-text fallback. GitHub-shaped only —
                         GitLab needs a numeric project id we can't ask the
                         user to type. When the only signed-in provider is
                         GitLab we render a dedicated info card instead
                         (gated outside the switch by manualGitlabOnly). -->
                    <label class="field">
                      <span>{{ 'pr.repo' | transloco }}</span>
                      <input
                        type="text"
                        [ngModel]="repoFullName()"
                        (ngModelChange)="repoFullName.set($event)"
                        name="repo"
                        placeholder="owner/repo"
                        pattern="^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"
                        autocomplete="off"
                        autocapitalize="none"
                        autocorrect="off"
                        spellcheck="false"
                        [attr.aria-invalid]="!!repoFullName() && !isValidRepo()"
                      />
                      @if (githubRepos().length > 0 || gitlabRepos().length > 0 || bitbucketRepos().length > 0) {
                        <button
                          type="button"
                          class="link-btn"
                          (click)="manualOverride.set(false); repoFullName.set('')"
                        >
                          {{ 'pr.pickFromList' | transloco }}
                        </button>
                      }
                      @if (repoFullName() && !isValidRepo()) {
                        <small class="hint hint-bad">
                          {{ 'pr.repoFormatHint' | transloco }}
                        </small>
                      }
                    </label>
                    <label class="field">
                      <span>{{ 'pr.baseBranch' | transloco }}</span>
                      <input
                        type="text"
                        [ngModel]="baseBranch()"
                        (ngModelChange)="baseBranch.set($event)"
                        name="base"
                        placeholder="main"
                        autocomplete="off"
                        spellcheck="false"
                      />
                    </label>
                  }
                }

                @let existing = existingPr();
                @if (existing && existing.state === 'opened') {
                  <!-- An open PR/MR already exists from the same source
                       branch into the same target. Don't try to create
                       a duplicate; bounce the user to the existing one
                       instead. The button is type=button so it doesn't
                       trigger the form's submit handler. -->
                  <button
                    type="button"
                    class="primary primary-existing"
                    (click)="openExisting(existing)"
                  >
                    @if (existing.provider === 'gitlab') {
                      {{ 'pr.openExistingMr' | transloco: { number: existing.number } }}
                    } @else {
                      {{ 'pr.openExistingPr' | transloco: { number: existing.number } }}
                    }
                    <svg class="btn-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                      <path d="M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
                      <path d="M6.06 9.94a.75.75 0 11-1.06-1.06l5.69-5.69H8.75a.75.75 0 010-1.5h3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V4.06l-5.44 5.88z"/>
                    </svg>
                  </button>
                } @else if (existing && existing.state === 'merged') {
                  <!-- Already merged into target — let the user view the
                       merged PR/MR but don't allow another submit. The
                       button stays clickable (so the user can navigate
                       to it) but renders in a "done" colour palette. -->
                  <button
                    type="button"
                    class="primary primary-merged"
                    (click)="openExisting(existing)"
                  >
                    @if (existing.provider === 'gitlab') {
                      {{ 'pr.alreadyMergedMr' | transloco: { branch: baseBranch(), number: existing.number } }}
                    } @else {
                      {{ 'pr.alreadyMergedPr' | transloco: { branch: baseBranch(), number: existing.number } }}
                    }
                    <svg class="btn-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                      <path d="M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
                      <path d="M6.06 9.94a.75.75 0 11-1.06-1.06l5.69-5.69H8.75a.75.75 0 010-1.5h3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V4.06l-5.44 5.88z"/>
                    </svg>
                  </button>
                } @else {
                  <!-- No existing PR/MR (or one that's closed-without-merge,
                       which we treat as "go ahead and create a new one").
                       This is the original create-button path. -->
                  <button
                    type="submit"
                    class="primary"
                    [disabled]="opening() || !canSubmit()"
                  >
                    @if (opening()) {
                      <span class="btn-spinner" aria-hidden="true"></span>
                      {{ 'pr.opening' | transloco }}
                    } @else {
                      @switch (targetProvider()) {
                        @case ('gitlab') {
                          @if (effectiveRepoName()) {
                            {{ 'pr.openOnGitLabFor' | transloco: { repo: effectiveRepoName() } }}
                          } @else {
                            {{ 'pr.openOnGitLab' | transloco }}
                          }
                        }
                        @case ('bitbucket') {
                          @if (effectiveRepoName()) {
                            {{ 'pr.openOnBitbucketFor' | transloco: { repo: effectiveRepoName() } }}
                          } @else {
                            {{ 'pr.openOnBitbucket' | transloco }}
                          }
                        }
                        @default {
                          @if (effectiveRepoName()) {
                            {{ 'pr.openOnGitHubFor' | transloco: { repo: effectiveRepoName() } }}
                          } @else {
                            {{ 'pr.openOnGitHub' | transloco }}
                          }
                        }
                      }
                      <svg class="btn-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                        <path d="M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
                        <path d="M6.06 9.94a.75.75 0 11-1.06-1.06l5.69-5.69H8.75a.75.75 0 010-1.5h3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V4.06l-5.44 5.88z"/>
                      </svg>
                    }
                  </button>
                }
              </form>

              @if (lastError(); as e) {
                <p class="error" role="alert">{{ e }}</p>
              }
              @if (lastPrUrl(); as url) {
                <p class="success" role="status">
                  @if (targetProvider() === 'gitlab') {
                    {{ 'pr.openedMr' | transloco }}
                  } @else {
                    {{ 'pr.opened' | transloco }}
                  }
                  <a [href]="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
                </p>
              }
            } @else {
              <p class="muted">{{ 'pr.signInForButtonGeneric' | transloco }}</p>
            }
          }
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; margin: 1rem 0; }

    .pr {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 14px);
      padding: clamp(1.1rem, 2vw, 1.5rem);
      background: var(--surface-2, #fff);
      box-shadow: var(--shadow-1);
    }
    .pr header h3 {
      margin: 0 0 0.3rem;
      font-size: 1.1rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.88rem; margin: 0 0 0.85rem; line-height: 1.5; }
    .empty { color: var(--fg-dim, #64748b); }

    .meta {
      display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
      font-size: 0.85rem; margin-bottom: 0.85rem;
      color: var(--fg-dim);
    }
    .branch-pill {
      font: 0.78rem var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      background: var(--surface-1, #f8fafc);
      border: 1px solid var(--border-subtle, var(--border));
      padding: 0.18rem 0.5rem; border-radius: var(--radius-pill, 999px);
      color: var(--fg);
    }

    details { margin: 0.55rem 0; }
    details summary {
      cursor: pointer; font-weight: 600; font-size: 0.88rem; padding: 0.3rem 0;
      color: var(--fg);
    }
    pre.diff, pre.body {
      background: var(--surface-1, #f8fafc);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-md, 10px);
      padding: 0.75rem 0.9rem;
      max-height: 24rem; overflow: auto;
      font: 0.78rem/1.45 var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      white-space: pre;
      margin: 0.5rem 0;
      color: var(--fg);
    }
    pre.diff code, pre.body code { background: transparent; padding: 0; }

    /* === Push form layout === */
    .push {
      margin-top: 1.1rem; padding-top: 1.1rem;
      border-top: 1px dashed var(--border, #e5e7eb);
      display: grid; gap: 0.75rem;
      grid-template-columns: 1fr;
    }
    /* On wider screens lay form rows out side by side, with the submit
       button taking the full width below. */
    @media (min-width: 640px) {
      .push { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
      .push button.primary { grid-column: 1 / -1; justify-self: stretch; }
      .push .active-repo { grid-column: 1 / -1; }
    }

    /* === Path 1: active repo badge === */
    .active-repo {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.85rem 1rem;
      border-radius: var(--radius-md, 10px);
      background: var(--accent-gradient-soft);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .active-repo-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px;
      border-radius: 50%;
      background: var(--surface-1);
      border: 1px solid var(--border);
      color: var(--accent);
      flex-shrink: 0;
    }
    .active-repo-meta {
      display: flex; flex-direction: column; gap: 0.1rem; min-width: 0;
    }
    .active-repo-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
      color: var(--fg-dim);
    }
    .active-repo-name {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--fg);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      word-break: break-all;
    }
    .active-repo-name:hover { color: var(--accent); }
    .private-badge {
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.1rem 0.5rem;
      border-radius: var(--radius-pill, 999px);
      background: var(--surface-1);
      border: 1px solid var(--border);
      color: var(--fg-dim);
    }

    .branch-row {
      align-self: end;
    }
    .branch-row.branch-loading,
    .branch-row.branch-single {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--fg-dim);
      padding: 0.55rem 0.65rem;
      border-radius: var(--radius-md, 10px);
      background: var(--surface-1);
      border: 1px solid var(--border-subtle, var(--border));
    }
    .branch-row .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 1.4s var(--ease, ease) infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.85); }
      50%      { opacity: 1;   transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .branch-row .dot { animation: none; }
    }

    /* === Field primitives === */
    .field {
      display: flex; flex-direction: column; gap: 0.3rem;
      font-size: 0.8rem; color: var(--fg-dim, #64748b);
      min-width: 0;
    }
    .field span {
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-size: 0.7rem;
    }
    .field input,
    .field select {
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-md, 10px);
      font: inherit;
      font-size: 0.9rem;
      color: var(--fg);
      background: var(--surface-1);
      min-height: 38px;
      transition: border-color 160ms var(--ease, ease), box-shadow 160ms var(--ease, ease);
    }
    .field input:focus,
    .field select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .field input[aria-invalid='true'] { border-color: var(--bad, #ef4444); }
    .hint { font-size: 0.74rem; margin-top: 0.1rem; }
    .hint-bad { color: var(--bad, #ef4444); }

    .link-btn {
      align-self: flex-start;
      background: transparent;
      border: none;
      color: var(--accent);
      font-size: 0.74rem;
      padding: 0;
      margin-top: 0.1rem;
      cursor: pointer;
      text-decoration: underline;
    }
    .link-btn:hover { color: var(--fg); }
    .link-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* === Buttons === */
    button { font: inherit; cursor: pointer; }
    button.primary {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 0.5rem;
      padding: 0 1.1rem;
      min-height: 44px;
      border-radius: var(--radius-md, 10px);
      border: 1px solid transparent;
      background: var(--accent-gradient, var(--accent, #2563eb));
      color: #fff;
      font-weight: 600; font-size: 0.95rem;
      letter-spacing: 0.01em;
      box-shadow: var(--shadow-1);
      transition: transform 120ms var(--ease, ease), box-shadow 200ms var(--ease, ease), filter 160ms var(--ease, ease);
    }
    button.primary:hover:not([disabled]) {
      transform: translateY(-1px);
      box-shadow: var(--shadow-glow);
      filter: brightness(1.04);
    }
    button.primary:active:not([disabled]) { transform: translateY(0); }
    button.primary[disabled] { opacity: 0.55; cursor: not-allowed; }

    /* Three-state submit button — variants for the existing-PR/MR cases.
       primary-existing: an opened PR/MR; the button is a "view" CTA, not
       a "submit" — uses a slightly cooler accent so it reads as
       informational rather than action-y.
       primary-merged: shipped already — green palette, still clickable
       so the user can navigate to the merged PR/MR but never submits. */
    button.primary.primary-existing {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--accent) 70%, var(--surface-2)),
        color-mix(in srgb, var(--accent) 95%, var(--surface-2)));
    }
    button.primary.primary-merged {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--ok, #22c55e) 80%, var(--surface-2)),
        color-mix(in srgb, var(--ok, #16a34a) 95%, var(--surface-2)));
    }
    .btn-icon { flex-shrink: 0; opacity: 0.85; }
    .btn-spinner {
      width: 14px; height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.45);
      border-top-color: #fff;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .btn-spinner { animation-duration: 0s; }
    }

    button.ghost {
      padding: 0.4rem 0.85rem; border-radius: var(--radius-md, 10px);
      background: transparent; border: 1px solid var(--border, #e5e7eb);
      font-size: 0.78rem; margin-top: 0.5rem;
      color: var(--fg-dim);
      transition: border-color 160ms var(--ease, ease), color 160ms var(--ease, ease);
    }
    button.ghost:hover { border-color: var(--accent); color: var(--fg); }

    /* === Manual-GitLab-only info card === */
    .manual-gitlab-only {
      margin-top: 1.1rem;
      padding: 1rem 1.1rem;
      display: flex;
      gap: 0.85rem;
      align-items: flex-start;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      background: var(--accent-gradient-soft);
      border-radius: var(--radius-md, 10px);
    }
    .mgo-icon {
      flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      border-radius: 50%;
      background: var(--surface-1);
      border: 1px solid var(--border);
      color: var(--accent);
    }
    .mgo-body { min-width: 0; flex: 1; }
    .mgo-body h4 {
      margin: 0 0 0.2rem;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--fg);
    }
    .mgo-body p { margin: 0 0 0.6rem; font-size: 0.85rem; line-height: 1.5; }
    .mgo-actions {
      display: inline-flex; flex-wrap: wrap; gap: 0.45rem;
      align-items: center;
      color: var(--fg-dim);
      font-size: 0.78rem;
    }
    .link-btn-strong {
      color: var(--accent);
      font-weight: 600;
    }

    /* === Status messages === */
    .success {
      color: var(--ok, #15803d);
      font-size: 0.88rem;
      margin-top: 0.85rem;
      padding: 0.6rem 0.85rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--ok, #22c55e) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--ok, #22c55e) 35%, var(--border));
    }
    .success a { color: inherit; word-break: break-all; }
    .error {
      color: var(--bad, #b91c1c);
      font-size: 0.88rem;
      margin-top: 0.85rem;
      padding: 0.65rem 0.9rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--bad, #ef4444) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border));
    }
  `]
})
export class PrPreviewComponent {
  private readonly generator = inject(PrGeneratorService);
  private readonly tokens = inject(ProviderTokenStore);
  private readonly toast = inject(ToastService);
  private readonly scanner = inject(ProjectScannerService);
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly existingLookup = inject(ExistingPrLookupService);

  readonly report = input<CompatibilityReport | null>(null);
  readonly parsed = input<ParsedPackageJson | null>(null);
  readonly rawPackageJson = input<string | null>(null);
  /** Optional pre-filled repo name (e.g. from a workspace handoff). */
  readonly initialRepo = input<string | null>(null);
  /**
   * The repo the user picked at the start of the session. When supplied,
   * the picker is replaced with a read-only badge — no manual entry.
   */
  readonly activeRepo = input<NormalizedRepo | null>(null);

  readonly artifacts = computed<PrArtifacts | null>(() => {
    const r = this.report();
    const p = this.parsed();
    if (!r || !p) return null;
    return this.generator.buildArtifacts(p, r, this.rawPackageJson());
  });

  readonly canPushToGitHub = computed(() => this.tokens.has('github'));
  readonly canPushToGitLab = computed(() => this.tokens.has('gitlab'));
  readonly canPushToBitbucket = computed(() => this.tokens.has('bitbucket'));
  /**
   * True when the user can submit a PR/MR somewhere — GitHub, GitLab, or
   * Bitbucket. The form gate uses this; the dispatch logic later picks
   * which provider to call against based on `targetProvider()`.
   */
  readonly canPush = computed(
    () =>
      this.canPushToGitHub() ||
      this.canPushToGitLab() ||
      this.canPushToBitbucket()
  );

  /**
   * Scanned repos for each provider — kept as full `NormalizedRepo[]` for
   * ALL providers (parity-symmetric). An earlier version stored GitHub as
   * `string[]` of fullNames, but that broke dropdown-mode branch loading
   * because we had no `defaultBranch`/`id` to call the API with. Now all
   * three providers carry the same shape and the effect downstream can
   * uniformly load branches off `effectiveRepo()` regardless of which
   * provider supplied the repo.
   */
  readonly githubRepos = computed<NormalizedRepo[]>(() => {
    return this.scanner.projects()
      .filter((p) => p.repo.provider === 'github')
      .map((p) => p.repo)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  readonly gitlabRepos = computed<NormalizedRepo[]>(() => {
    return this.scanner.projects()
      .filter((p) => p.repo.provider === 'gitlab')
      .map((p) => p.repo)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  readonly bitbucketRepos = computed<NormalizedRepo[]>(() => {
    return this.scanner.projects()
      .filter((p) => p.repo.provider === 'bitbucket')
      .map((p) => p.repo)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  /** When true, the user explicitly asked to type the repo name. */
  readonly manualOverride = signal(false);

  /**
   * UI mode driven by inputs and user intent. Resolves in this priority:
   *   - active-repo: an `activeRepo` is supplied (GitHub OR GitLab) AND user
   *                  hasn't overridden
   *   - dropdown:    we have scanned repos for at least one supported
   *                  provider AND user hasn't overridden
   *   - manual:      free-text fallback (anonymous flow, or user override)
   *                  — manual entry only resolves to GitHub today; GitLab
   *                  needs a numeric project id which can't be typed.
   */
  readonly mode = computed<'active-repo' | 'dropdown' | 'manual'>(() => {
    if (this.manualOverride()) return 'manual';
    const ar = this.activeRepo();
    if (
      ar &&
      (ar.provider === 'github' ||
        ar.provider === 'gitlab' ||
        ar.provider === 'bitbucket')
    ) {
      return 'active-repo';
    }
    if (
      this.githubRepos().length > 0 ||
      this.gitlabRepos().length > 0 ||
      this.bitbucketRepos().length > 0
    ) {
      return 'dropdown';
    }
    return 'manual';
  });

  /**
   * Repo currently picked in dropdown / typed in manual mode. Lifted to a
   * signal so `effectiveRepo()` and the branch-loading effect can react
   * when the user changes their selection — the previous plain-property
   * version meant dropdown mode never auto-fetched branches.
   */
  readonly repoFullName = signal('');
  /** Base branch — signal so future MR-existence lookups can react to it. */
  readonly baseBranch = signal('main');

  /**
   * Provider we're currently targeting — drives both label rendering and
   * the dispatch in `open()`. We resolve in priority:
   *   1. activeRepo's provider (GitHub or GitLab) when in active-repo mode
   *   2. The provider whose dropdown selection the user last picked, if any
   *   3. Whatever single provider has a token (so the labels read sensibly
   *      before the user makes a choice)
   *   4. Fall back to GitHub (the manual-input default)
   */
  readonly targetProvider = computed<PushableProvider>(() => {
    if (this.mode() === 'active-repo') {
      const p = this.activeRepo()?.provider;
      if (p === 'gitlab') return 'gitlab';
      if (p === 'bitbucket') return 'bitbucket';
      return 'github';
    }
    const picked = this.repoFullName().trim();
    if (picked) {
      const isGitLab = this.gitlabRepos().some((r) => r.fullName === picked);
      if (isGitLab) return 'gitlab';
      const isBitbucket = this.bitbucketRepos().some((r) => r.fullName === picked);
      if (isBitbucket) return 'bitbucket';
      const isGitHub = this.githubRepos().some((r) => r.fullName === picked);
      if (isGitHub) return 'github';
    }
    // Fallback chain for manual mode (where we have no scanned repo to
    // disambiguate). GitHub first because it's the most common; Bitbucket
    // before GitLab because Bitbucket can also be typed (workspace/repo
    // format) while GitLab needs a numeric project id manual entry can't
    // produce.
    if (this.canPushToGitHub()) return 'github';
    if (this.canPushToBitbucket()) return 'bitbucket';
    if (this.canPushToGitLab()) return 'gitlab';
    return 'github';
  });

  /** The repo we'll actually open the PR/MR against, regardless of mode. */
  readonly effectiveRepoName = computed<string>(() => {
    const m = this.mode();
    if (m === 'active-repo') return this.activeRepo()?.fullName ?? '';
    return this.repoFullName().trim();
  });

  /**
   * Resolved repo for dispatching. Resolves from BOTH provider lists in
   * dropdown mode — earlier the GitHub case returned null because we
   * didn't keep a NormalizedRepo for GitHub, which broke dropdown-mode
   * branch loading. Now both providers store the same shape and either
   * one can be picked uniformly.
   */
  readonly effectiveRepo = computed<NormalizedRepo | null>(() => {
    const m = this.mode();
    if (m === 'active-repo') return this.activeRepo();
    if (m === 'dropdown') {
      const name = this.repoFullName().trim();
      if (!name) return null;
      const all = [
        ...this.githubRepos(),
        ...this.gitlabRepos(),
        ...this.bitbucketRepos()
      ];
      return all.find((r) => r.fullName === name) ?? null;
    }
    return null;
  });

  /**
   * True when the only signed-in provider is GitLab and we'd otherwise
   * drop the user into the manual-entry form. Manual entry takes a
   * slash-shaped string (`owner/repo` for GitHub, `workspace/repo_slug`
   * for Bitbucket) — GitLab is the odd one out because its API needs a
   * numeric project id we can't ask the user to type. We block the form
   * in that case and render an info card pointing at /projects (to scan
   * their GitLab repos) or /sign-in (to add a typeable provider).
   *
   * Bitbucket explicitly does NOT trigger this branch — its manual entry
   * works just like GitHub's.
   */
  readonly manualGitlabOnly = computed(
    () =>
      this.mode() === 'manual' &&
      this.canPushToGitLab() &&
      !this.canPushToGitHub() &&
      !this.canPushToBitbucket()
  );

  readonly opening = signal(false);
  readonly lastPrUrl = signal<string | null>(null);
  readonly lastError = signal<string | null>(null);

  /** Branches discovered for the active repo. Empty during fetch / on error. */
  readonly branches = signal<string[]>([]);
  readonly branchesLoading = signal(false);

  /**
   * Branches the user can pick as the *base* (target) of the PR/MR.
   *
   * Two filters applied to the raw `branches()` list:
   *   1. The active source branch (`artifacts.branchName`, e.g.
   *      `chore/ng21-deps-2026-05-06`) is excluded — a branch can't merge
   *      into itself, and surfacing it just invites a "branch can't equal
   *      target" 400 from the provider.
   *   2. Branches stay in the same alphabetic / default-branch-first order
   *      `loadBranches()` set — sorting is delegated to the grouping
   *      computeds below so the dropdown can show two ordered groups.
   */
  readonly displayBranches = computed<string[]>(() => {
    const headBranch = this.artifacts()?.branchName;
    if (!headBranch) return this.branches();
    return this.branches().filter((b) => b !== headBranch);
  });

  /**
   * Strict regex for branches we generated on a previous run. We only
   * match the exact shape `chore/ng<MAJOR>-deps-YYYY-MM-DD` so unrelated
   * `chore/...` branches the user named themselves don't get bucketed
   * into the "Previous tool updates" group by accident.
   */
  private static readonly TOOL_BRANCH_RE = /^chore\/ng\d+-deps-\d{4}-\d{2}-\d{2}$/;

  /**
   * Branches that are part of the user's normal project history. Default
   * branch stays first (preserves the order from `loadBranches`); the rest
   * stay alphabetized.
   */
  readonly projectBranches = computed<string[]>(() =>
    this.displayBranches().filter(
      (b) => !PrPreviewComponent.TOOL_BRANCH_RE.test(b)
    )
  );

  /**
   * Branches we generated on previous runs of this tool. Sorted reverse-
   * chronologically — branch names embed the date in YYYY-MM-DD form so
   * a lexicographic descending sort is also a date-descending sort. This
   * surfaces "yesterday's update" first, which is the branch users
   * stacking new bumps almost always want.
   */
  readonly previousToolBranches = computed<string[]>(() =>
    this.displayBranches()
      .filter((b) => PrPreviewComponent.TOOL_BRANCH_RE.test(b))
      .sort((a, b) => b.localeCompare(a))
  );

  /**
   * True when the dropdown should render two `<optgroup>`s rather than a
   * flat list. Also gates the visual "stack here" hint in the second
   * group's label.
   */
  readonly hasGroupedBranches = computed(
    () => this.previousToolBranches().length > 0
  );

  /**
   * Existing PR/MR for the current `(repo, source, target)` triple, or
   * `null` if no existing PR/MR was found / lookup not yet attempted.
   * Drives the three-state submit button.
   */
  readonly existingPr = signal<ExistingPr | null>(null);
  readonly lookupInFlight = signal(false);

  readonly canSubmit = computed(() => {
    const m = this.mode();
    if (m === 'active-repo') return !!this.activeRepo()?.fullName;
    if (this.manualGitlabOnly()) return false;
    return !!this.repoFullName() && this.isValidRepo();
  });

  isValidRepo(): boolean {
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(this.repoFullName().trim());
  }

  constructor() {
    // Pre-fill repo from initialRepo when there's no activeRepo.
    queueMicrotask(() => {
      if (!this.repoFullName() && !this.activeRepo() && this.initialRepo()) {
        this.repoFullName.set(this.initialRepo()!);
      }
    });

    // Branch loading runs uniformly for active-repo AND dropdown modes via
    // `effectiveRepo()` — both modes resolve to a `NormalizedRepo` we can
    // hand to the provider's branches API. Manual mode resolves to null
    // and stays in the typed-input fallback.
    //
    // We don't run during prerender — the branches call needs an OAuth
    // token that only exists in the browser. BitBucket / Azure don't have
    // a one-click PR path yet so we leave branches empty for them and the
    // form falls through to the text-input fallback.
    effect(() => {
      const repo = this.effectiveRepo();
      if (
        !repo ||
        (repo.provider !== 'github' &&
          repo.provider !== 'gitlab' &&
          repo.provider !== 'bitbucket')
      ) {
        this.branches.set([]);
        return;
      }
      this.baseBranch.set(repo.defaultBranch || 'main');
      if (isPlatformBrowser(this.platformId)) {
        this.loadBranches(repo);
      }
    });

    // Existing PR/MR lookup. Fires whenever any of (effectiveRepo,
    // baseBranch, artifacts.branchName) changes — debounced 250ms so
    // toggling between branches in the dropdown doesn't spam the API.
    // We use `toObservable` to bridge the signals into rxjs (where we
    // get debounce + switchMap "cancel previous request" semantics for
    // free), then hand the result back to a signal for template binding.
    //
    // The input shape is a synthetic key object so unrelated changes
    // (e.g. toggling `manualOverride` while the same repo is active)
    // don't refire the lookup unnecessarily. distinctUntilChanged would
    // help further; we skip it for now because debounceTime + a quick
    // null-equality check at the start of the pipeline cover most of
    // the real-world refire patterns.
    const lookupKey = computed(() => {
      const repo = this.effectiveRepo();
      const target = this.baseBranch();
      const source = this.artifacts()?.branchName ?? '';
      if (!repo || !source || !target) return null;
      return { repo, source, target };
    });

    if (isPlatformBrowser(this.platformId)) {
      toObservable(lookupKey)
        .pipe(
          debounceTime(250),
          switchMap((key) => {
            if (!key) {
              this.lookupInFlight.set(false);
              return of<ExistingPr | null>(null);
            }
            this.lookupInFlight.set(true);
            return this.existingLookup
              .findExisting(key.repo, key.source, key.target)
              .pipe(catchError(() => of<ExistingPr | null>(null)));
          }),
          takeUntilDestroyed()
        )
        .subscribe((result) => {
          this.lookupInFlight.set(false);
          this.existingPr.set(result);
        });
    }
  }

  private loadBranches(repo: NormalizedRepo): void {
    const token = this.tokens.tokenFor(repo.provider as AuthProvider);
    if (!token) {
      // No token → leave branches empty; form falls back to text input
      // pre-filled with defaultBranch.
      this.branches.set([]);
      return;
    }

    this.branchesLoading.set(true);
    const url =
      repo.provider === 'gitlab'
        ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.id)}/repository/branches?per_page=100`
        : repo.provider === 'bitbucket'
          ? `https://api.bitbucket.org/2.0/repositories/${repo.fullName}/refs/branches?pagelen=100`
          : `https://api.github.com/repos/${repo.fullName}/branches?per_page=100`;

    const headers =
      repo.provider === 'github'
        ? new HttpHeaders({
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          })
        : new HttpHeaders({ Authorization: `Bearer ${token}` });

    // GitHub returns `[{name, ...}]` (a flat array), GitLab returns
    // `[{name, ...}]` (also flat). Bitbucket returns paginated
    // `{values: [{name, ...}]}`. We normalize all three to a flat list
    // of names below. We cap at 100 — repos with hundreds of branches
    // are rare and the user can always type one with the manual override.
    type FlatBranch = { name: string };
    type BranchResponse = FlatBranch[] | { values?: FlatBranch[] };
    this.http
      .get<BranchResponse>(url, { headers })
      .pipe(catchError(() => of([] as FlatBranch[])))
      .subscribe((res) => {
        const list: FlatBranch[] = Array.isArray(res)
          ? res
          : (res?.values ?? []);
        const names = list.map((b) => b.name);
        // Surface the default branch first; alphabetize the rest.
        const def = repo.defaultBranch;
        names.sort((a, b) => {
          if (a === def) return -1;
          if (b === def) return 1;
          return a.localeCompare(b);
        });
        this.branches.set(names);
        this.branchesLoading.set(false);
        // Make sure baseBranch is one of the discovered branches.
        if (names.length && !names.includes(this.baseBranch())) {
          this.baseBranch.set(names[0]);
        }
      });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied to clipboard.');
    } catch {
      window.prompt('Copy:', text);
    }
  }

  /**
   * Open an existing PR/MR in a new tab. Used by the "Open existing"
   * and "Already merged" button states. Triggered synchronously inside
   * a click handler so popup blockers respect the user gesture.
   */
  openExisting(existing: ExistingPr): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const popup = window.open(existing.url, '_blank', 'noopener,noreferrer');
    if (!popup) {
      this.toast.info?.('Allow pop-ups, or open the link below.');
    }
  }

  open(ev: Event, artifacts: PrArtifacts): void {
    ev.preventDefault();
    const fullName = this.effectiveRepoName();
    if (!fullName) return;
    if (this.mode() !== 'active-repo' && !this.isValidRepo()) return;

    this.opening.set(true);
    this.lastError.set(null);
    this.lastPrUrl.set(null);

    const provider = this.targetProvider();
    const baseBranch = this.baseBranch().trim() || 'main';
    const headBranch = artifacts.branchName;

    // Pick the right service call. GitLab needs the numeric project id,
    // which we only have when the user picked from the active-repo or
    // dropdown path (not from the manual text-entry path). GitHub and
    // Bitbucket both route by `owner/repo` / `workspace/repo_slug` and
    // accept manual entry directly.
    const dispatch$ =
      provider === 'gitlab'
        ? (() => {
            const repo = this.effectiveRepo();
            if (!repo || repo.provider !== 'gitlab') {
              this.opening.set(false);
              this.lastError.set('GitLab project id missing — pick the repo from the dropdown.');
              return null;
            }
            return this.generator.createGitLabMr({
              projectId: repo.id,
              fullName,
              baseBranch,
              headBranch,
              artifacts
            });
          })()
        : provider === 'bitbucket'
          ? this.generator.createBitbucketPr({
              fullName,
              baseBranch,
              headBranch,
              artifacts
            })
          : this.generator.createGitHubPr({
              fullName,
              baseBranch,
              headBranch,
              artifacts
            });

    if (!dispatch$) return;

    dispatch$.subscribe({
      next: (res) => {
        this.opening.set(false);
        this.lastPrUrl.set(res.url);
        const label = provider === 'gitlab'
          ? `MR !${res.number} opened.`
          : `PR #${res.number} opened.`;
        this.toast.success(label);
        // Auto-open in a new tab. Triggered synchronously inside the user
        // gesture path (form submit) so popup blockers respect it.
        if (isPlatformBrowser(this.platformId)) {
          const popup = window.open(res.url, '_blank', 'noopener,noreferrer');
          if (!popup) {
            this.toast.info?.('Allow pop-ups to auto-open the PR — link below works too.');
          }
        }
      },
      error: (err) => {
        this.opening.set(false);
        this.lastError.set(this.friendlyError(err, fullName, provider));
      }
    });
  }

  private friendlyError(
    err: unknown,
    fullName: string,
    provider: PushableProvider
  ): string {
    const status = (err as { status?: number })?.status;
    const msg =
      (err as { message?: string })?.message ??
      (provider === 'gitlab' ? 'Failed to open MR.' : 'Failed to open PR.');
    const host =
      provider === 'gitlab'
        ? 'GitLab'
        : provider === 'bitbucket'
          ? 'Bitbucket'
          : 'GitHub';
    const what = provider === 'gitlab' ? 'MR' : 'PR';

    if (status === 404) {
      return `Can't find a repo called "${fullName}", or your ${host} token can't see it. Try signing out and back in to refresh permissions.`;
    }
    if (status === 401 || status === 403) {
      // GitLab and Bitbucket are both much more likely to 403 because of
      // a missing write scope than because the user lacks repo permission,
      // so we lead with the scope hint for them. GitHub's `repo` scope is
      // granted at sign-in and rarely missing, so we keep its message
      // generic.
      if (provider === 'gitlab') {
        return `Your GitLab token doesn't have permission to push to "${fullName}". This usually means the token was issued without write access — sign out and back in to grant the api scope, then try again.`;
      }
      if (provider === 'bitbucket') {
        return `Your Bitbucket token doesn't have permission to push to "${fullName}". This usually means the token was issued without write access — sign out and back in to grant the repository:write and pullrequest:write scopes, then try again.`;
      }
      return `Your ${host} token can't push to "${fullName}". Sign out and back in to refresh permissions, or pick a repo you own.`;
    }
    if (status === 422 || status === 409) {
      return `${host} rejected the request. A ${what} from the same branch on "${fullName}" may already exist.`;
    }
    if (status === 400 && provider === 'gitlab') {
      return `GitLab rejected the request — typically because the branch already exists or your token lacks the api scope.`;
    }
    if (status === 400 && provider === 'bitbucket') {
      return `Bitbucket rejected the request — typically because the branch already exists, or your token lacks the repository:write / pullrequest:write scopes.`;
    }
    if (status === 0) {
      return `Network error reaching ${host}. Check your connection and try again.`;
    }
    return msg;
  }
}
