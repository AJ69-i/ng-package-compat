import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  ViewChild,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';

import {
  NpmSearchService,
  NpmSearchSuggestion
} from '../../services/npm-search.service';
import { FavoritesService } from '../../services/favorites.service';
import { StripHtmlPipe } from '../../pipes/strip-html.pipe';

/**
 * Enterprise-grade search autocomplete.
 *
 * - Race-condition-proof via NpmSearchService's RxJS pipeline.
 * - Full keyboard support: Arrow up/down, Enter, Escape, Tab.
 * - Announced to screen readers via aria-live region.
 * - Respects PLATFORM_ID — no DOM access during SSR.
 */
@Component({
  selector: 'app-autocomplete-input',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule, StripHtmlPipe],
  // CRITICAL: NpmSearchService is declared `providedIn: 'root'` for
  // historical reasons (early in the project there was only ever one
  // search box on screen). Now we have at least two simultaneously on
  // /compare (and could have more in the future). Promoting the service
  // to component-level providers gives each `<app-autocomplete-input>`
  // its own service instance — its own Subject, its own debounce, its
  // own query$ stream — so typing in input A no longer drives input
  // B's dropdown.
  //
  // This DOES override the root-level provider for any component that
  // sits inside an autocomplete (none today), but the service is only
  // injected by this component, so the override is contained.
  providers: [NpmSearchService],
  templateUrl: './autocomplete-input.component.html',
  styleUrls: ['./autocomplete-input.component.scss']
})
export class AutocompleteInputComponent implements OnInit, OnChanges, OnDestroy {
  @Input() value = '';
  @Input() placeholder = '';
  @Input() ariaLabel = '';
  @Input() disabled = false;
  @Input() inputId = 'autocomplete-input';
  /**
   * Optional package name to exclude from suggestions. Used on /compare
   * to prevent self-comparison: if input A already holds `ngx-toastr`,
   * we filter `ngx-toastr` out of input B's suggestions so the user
   * literally cannot pick the same package on both sides. Case-insensitive
   * exact match — partial matches still appear because someone typing
   * "ngx" should still see `ngx-toastr` in the OTHER input.
   *
   * Default '' means "filter nothing" — preserves existing call sites
   * that don't pass this input at all.
   */
  @Input() excludeName = '';

  @Output() valueChange = new EventEmitter<string>();
  /** Fired when a suggestion is confirmed (click or Enter on a highlighted row). */
  @Output() picked = new EventEmitter<string>();
  /** Fired when the user presses Enter on the raw input (no suggestion chosen). */
  @Output() submitted = new EventEmitter<string>();

  @ViewChild('input') inputRef?: ElementRef<HTMLInputElement>;

  private readonly search = inject(NpmSearchService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly favorites = inject(FavoritesService);

  readonly suggestions = signal<NpmSearchSuggestion[]>([]);
  readonly open = signal<boolean>(false);
  readonly highlighted = signal<number>(-1);
  readonly loading = signal<boolean>(false);

  private sub?: Subscription;

  ngOnInit(): void {
    if (!this.isBrowser) return;
    this.sub = this.search.query$.subscribe((raw) => {
      // Apply the exclusion BEFORE setting state so the highlighted-index
      // bookkeeping below sees the same list the user does. Doing it any
      // later (e.g. in a computed signal over `suggestions`) would mean
      // pressing ArrowDown can highlight rows that aren't rendered.
      const suggestions = this.applyExclusion(raw);
      this.suggestions.set(suggestions);
      this.loading.set(false);
      this.open.set(suggestions.length > 0);
      this.highlighted.set(suggestions.length ? 0 : -1);
    });
  }

  /**
   * Filter out the package named in `excludeName`. Case-insensitive exact
   * match — we don't want partial matches because "ngx-tooltip" and
   * "ngx-toastr" shouldn't be the same exclusion target. If the user
   * clears the OTHER input mid-search, this becomes a no-op on the next
   * keystroke (the empty-string check short-circuits).
   */
  private applyExclusion(list: NpmSearchSuggestion[]): NpmSearchSuggestion[] {
    const exclude = this.excludeName.trim().toLowerCase();
    if (!exclude) return list;
    return list.filter((s) => s.name.toLowerCase() !== exclude);
  }

  /**
   * Re-filter the currently-displayed list when `excludeName` changes —
   * covers the case where the user has the dropdown open here and then
   * picks a package in the OTHER input. Without this, the dropdown would
   * stale-display the now-excluded package until the next keystroke.
   *
   * Cheap operation: a single .filter() over at most 10 suggestions; no
   * network call, no subscription churn.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['excludeName'] && !changes['excludeName'].firstChange) {
      const current = this.suggestions();
      if (!current.length) return;
      const filtered = this.applyExclusion(current);
      // Only update if filtering actually changed something — avoids a
      // pointless OnPush invalidation when the excluded name isn't in
      // the visible list.
      if (filtered.length !== current.length) {
        this.suggestions.set(filtered);
        // If we removed the currently-highlighted row, snap to the top.
        if (this.highlighted() >= filtered.length) {
          this.highlighted.set(filtered.length ? 0 : -1);
        }
        if (!filtered.length) this.open.set(false);
      }
    }
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  onInput(raw: string): void {
    this.value = raw;
    this.valueChange.emit(raw);
    if (raw.trim().length >= 2) {
      this.loading.set(true);
      this.search.push(raw);
    } else {
      this.suggestions.set([]);
      this.open.set(false);
      this.loading.set(false);
    }
  }

  onFocus(): void {
    if (this.suggestions().length) this.open.set(true);
  }

  onBlur(): void {
    // Delay closing so clicks on dropdown items register first.
    setTimeout(() => this.open.set(false), 120);
  }

  /** Keyboard navigation on the input element itself. */
  onKeyDown(ev: KeyboardEvent): void {
    const list = this.suggestions();
    if (!list.length && ev.key !== 'Enter') return;

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        this.highlighted.set((this.highlighted() + 1) % list.length);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        this.highlighted.set(
          this.highlighted() <= 0 ? list.length - 1 : this.highlighted() - 1
        );
        break;
      case 'Enter': {
        const idx = this.highlighted();
        if (this.open() && idx >= 0 && list[idx]) {
          ev.preventDefault();
          this.pick(list[idx]);
        } else {
          this.submitted.emit(this.value);
        }
        break;
      }
      case 'Escape':
        ev.preventDefault();
        this.open.set(false);
        this.highlighted.set(-1);
        break;
      case 'Tab':
        this.open.set(false);
        break;
    }
  }

  pick(s: NpmSearchSuggestion): void {
    this.value = s.name;
    this.valueChange.emit(s.name);
    this.picked.emit(s.name);
    this.open.set(false);
    this.suggestions.set([]);
    this.highlighted.set(-1);
  }

  /** Star/unstar a package from the dropdown without selecting the row. */
  toggleFavorite(ev: MouseEvent, name: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.favorites.toggle(name);
  }

  trackByName(_: number, s: NpmSearchSuggestion): string {
    return s.name;
  }

  /** Close the dropdown if the user clicks outside the component. */
  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (!this.isBrowser) return;
    const host = this.inputRef?.nativeElement.closest('app-autocomplete-input');
    if (host && !host.contains(ev.target as Node)) {
      this.open.set(false);
    }
  }
}
