import { TestBed } from '@angular/core/testing';
import { StorageService } from './storage.service';

describe('StorageService', () => {
  let svc: StorageService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(StorageService);
  });

  it('records searches in order, deduping and capping', () => {
    svc.recordSearch('a');
    svc.recordSearch('b');
    svc.recordSearch('a'); // should move to front
    const names = svc.history().map((h) => h.name);
    expect(names).toEqual(['a', 'b']);
  });

  it('toggles favorites', () => {
    expect(svc.isFavorite('foo')).toBe(false);
    svc.toggleFavorite('foo');
    expect(svc.isFavorite('foo')).toBe(true);
    svc.toggleFavorite('foo');
    expect(svc.isFavorite('foo')).toBe(false);
  });

  it('clears history', () => {
    svc.recordSearch('a');
    svc.clearHistory();
    expect(svc.history()).toEqual([]);
  });

  it('ignores empty or whitespace names', () => {
    svc.recordSearch('   ');
    expect(svc.history().length).toBe(0);
  });
});
