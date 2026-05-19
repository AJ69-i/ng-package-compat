import { TestBed } from '@angular/core/testing';
import { FavoritesService } from './favorites.service';

describe('FavoritesService', () => {
  let svc: FavoritesService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(FavoritesService);
  });

  it('starts empty', () => {
    expect(svc.names()).toEqual([]);
    expect(svc.count()).toBe(0);
  });

  it('add/remove/toggle', () => {
    svc.add('rxjs');
    svc.add('rxjs'); // dedupes
    expect(svc.names()).toEqual(['rxjs']);
    svc.toggle('@angular/core');
    expect(svc.names()).toEqual(['rxjs', '@angular/core']);
    svc.toggle('rxjs');
    expect(svc.names()).toEqual(['@angular/core']);
    svc.remove('@angular/core');
    expect(svc.names()).toEqual([]);
  });

  it('move() reorders entries', () => {
    svc.add('a');
    svc.add('b');
    svc.add('c');
    svc.move(0, 2);
    expect(svc.names()).toEqual(['b', 'c', 'a']);
    svc.move(2, 0);
    expect(svc.names()).toEqual(['a', 'b', 'c']);
  });

  it('move() is a no-op for invalid indices', () => {
    svc.add('a');
    svc.add('b');
    svc.move(-1, 1);
    svc.move(0, 5);
    svc.move(1, 1);
    expect(svc.names()).toEqual(['a', 'b']);
  });

  it('clear() empties the list', () => {
    svc.add('one');
    svc.add('two');
    svc.clear();
    expect(svc.names()).toEqual([]);
  });
});
