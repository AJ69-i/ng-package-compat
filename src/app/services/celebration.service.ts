import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Fire-and-forget celebration effect: tiny canvas confetti burst.
 *
 * Stays zero-dependency by drawing ~120 colored rectangles on a full-viewport
 * canvas that self-removes after ~2.5s. Respects `prefers-reduced-motion`
 * (and the app's own `body.reduced-motion` flag) by playing a silent / tame
 * animation, so the celebration never triggers vestibular discomfort.
 *
 * Intended trigger points:
 *   - Health score reaches 100%
 *   - Dependency upgrade plan fully completed
 *   - Snapshot diff moves from red → green
 */
@Injectable({ providedIn: 'root' })
export class CelebrationService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly playing = signal<boolean>(false);

  /** Trigger a confetti burst once. Safe to call rapidly (guarded). */
  celebrate(): void {
    if (!this.isBrowser) return;
    if (this.playing()) return;
    const reduced = this.prefersReducedMotion();
    this.playing.set(true);
    if (reduced) {
      // Short, gentle fade pulse instead of a particle storm.
      this.softFlash();
      setTimeout(() => this.playing.set(false), 900);
      return;
    }
    this.burst();
  }

  private prefersReducedMotion(): boolean {
    if (document.body.classList.contains('reduced-motion')) return true;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  private softFlash(): void {
    const pulse = document.createElement('div');
    pulse.setAttribute('aria-hidden', 'true');
    pulse.style.cssText = `
      position: fixed; inset: 0; z-index: 80;
      background: radial-gradient(circle, rgba(16,185,129,0.18) 0%, transparent 60%);
      pointer-events: none; opacity: 0;
      transition: opacity 0.28s ease-in-out;
    `;
    document.body.appendChild(pulse);
    requestAnimationFrame(() => { pulse.style.opacity = '1'; });
    setTimeout(() => { pulse.style.opacity = '0'; }, 520);
    setTimeout(() => pulse.remove(), 880);
  }

  private burst(): void {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = `
      position: fixed; inset: 0; z-index: 80;
      width: 100vw; height: 100vh; pointer-events: none;
    `;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); this.playing.set(false); return; }
    ctx.scale(dpr, dpr);

    const colors = ['#6366f1', '#10b981', '#f97316', '#f59e0b', '#ec4899', '#38bdf8', '#a855f7'];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const count = Math.min(160, Math.max(80, Math.round(w / 10)));
    const particles = Array.from({ length: count }, () => ({
      x: w / 2 + (Math.random() - 0.5) * 120,
      y: h * 0.45 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -12 - 4,
      size: 6 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1
    }));

    const gravity = 0.35;
    const drag = 0.995;
    const fade = 0.012;
    const start = performance.now();
    const maxDurationMs = 2500;

    const step = (now: number): void => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of particles) {
        if (p.life <= 0) continue;
        p.vx *= drag;
        p.vy = p.vy * drag + gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= fade;
        if (p.y > h + 20 || p.life <= 0) continue;
        alive++;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.4);
        ctx.restore();
      }
      if (alive > 0 && elapsed < maxDurationMs) {
        requestAnimationFrame(step);
      } else {
        canvas.remove();
        this.playing.set(false);
      }
    };
    requestAnimationFrame(step);
  }
}
