import { Injectable } from '@angular/core';

/**
 * Tiny, dependency-free Markdown → safe-HTML renderer for the README
 * preview on the Search page.
 *
 * Why not pull in `marked` / `markdown-it` / `remark`?
 *
 *   • Bundle budget. The search-page chunk is already 82 kB raw; the
 *     smallest mainstream parser (`marked` ~30 kB min, more once you
 *     add the sanitizer) doubles the cost of a feature that only
 *     renders text we already have in memory.
 *   • Safety surface. Every full-fidelity parser supports raw HTML
 *     passthrough, which means every full-fidelity parser needs a
 *     real sanitizer (DOMPurify ~20 kB) bolted on. By writing our own
 *     restricted subset we never emit raw HTML in the first place —
 *     the only tags in the output are the ones this file generates,
 *     and every piece of user text is run through `escapeHtml()`
 *     before it lands in the output.
 *   • READMEs are remarkably uniform. The 95th-percentile npm README
 *     uses headings, paragraphs, fenced code, inline code, bold,
 *     italic, links, lists, images, blockquotes, and tables. That's
 *     the entire surface area this renderer covers.
 *
 * What we deliberately don't support:
 *
 *   • Raw HTML in the markdown (it's escaped as text — safer than
 *     trying to allowlist it).
 *   • Nested lists deeper than 2 levels (the parser collapses them).
 *   • Footnotes, definition lists, math, mermaid (none of which are
 *     useful in a README preview anyway).
 *
 * The output is plain HTML that `DomSanitizer.bypassSecurityTrustHtml`
 * can accept because we never emit user-controlled tag names or
 * attribute values — everything user-supplied is escaped first, and
 * URLs go through `safeUrl()` which rejects javascript:/data: schemes.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownRendererService {
  /**
   * Render markdown to a safe HTML string.
   *
   * @param markdown   The raw markdown text.
   * @param baseUrl    Optional base URL to resolve relative `![img](path)`
   *                   and `[link](path)` references against. README images
   *                   are almost always relative paths like `./logo.png`,
   *                   which only resolve correctly if we know the repo's
   *                   raw-content URL (e.g. `https://raw.githubusercontent.com/owner/repo/HEAD`).
   */
  render(markdown: string, baseUrl?: string): string {
    if (!markdown) return '';
    // Normalize line endings first — Windows-authored READMEs use \r\n.
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    return this.renderLines(lines, baseUrl ?? null);
  }

  private renderLines(lines: string[], baseUrl: string | null): string {
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip blank lines between blocks.
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Fenced code block ```lang ... ```
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1] || '';
        const code: string[] = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // closing fence
        out.push(this.renderCodeBlock(code.join('\n'), lang));
        continue;
      }

      // Horizontal rule
      if (/^([-*_])\1{2,}\s*$/.test(line)) {
        out.push('<hr />');
        i++;
        continue;
      }

      // ATX heading: # Heading
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        const text = this.renderInline(heading[2], baseUrl);
        out.push(`<h${level} class="md-h${level}">${text}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote: > ...
      if (/^>\s?/.test(line)) {
        const block: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          block.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        const inner = this.renderLines(block, baseUrl);
        out.push(`<blockquote class="md-bq">${inner}</blockquote>`);
        continue;
      }

      // Unordered list
      if (/^[-*+]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          const item = lines[i].replace(/^[-*+]\s+/, '');
          items.push(`<li>${this.renderInline(item, baseUrl)}</li>`);
          i++;
        }
        out.push(`<ul class="md-ul">${items.join('')}</ul>`);
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\d+\.\s+/, '');
          items.push(`<li>${this.renderInline(item, baseUrl)}</li>`);
          i++;
        }
        out.push(`<ol class="md-ol">${items.join('')}</ol>`);
        continue;
      }

      // Table — basic GFM: header row, separator row, body rows
      if (line.includes('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const header = this.splitTableRow(line);
        i += 2;
        const body: string[][] = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          body.push(this.splitTableRow(lines[i]));
          i++;
        }
        out.push(this.renderTable(header, body, baseUrl));
        continue;
      }

      // Paragraph: greedily consume until blank line / block element
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^[-*+]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^([-*_])\1{2,}\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      const text = this.renderInline(para.join(' '), baseUrl);
      out.push(`<p class="md-p">${text}</p>`);
    }

    return out.join('\n');
  }

  // ------ Inline ------

  /**
   * Inline markdown — code, bold, italic, links, images, br.
   *
   * Order matters: code spans first (so * and _ inside backticks
   * aren't interpreted), then images (so the inner `[alt]` isn't
   * mistaken for a link), then links, then bold, then italic.
   */
  private renderInline(text: string, baseUrl: string | null): string {
    let s = this.escapeHtml(text);

    // Inline code: `code` — must run BEFORE bold/italic so backticks
    // protect their contents from further markdown processing. We
    // stash matches with a placeholder so subsequent passes can't
    // touch them, then re-substitute at the end.
    const codeStash: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_m, code) => {
      const idx = codeStash.length;
      codeStash.push(`<code class="md-code">${code}</code>`);
      return `\x00CODE${idx}\x00`;
    });

    // Images: ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, url, title) => {
      const safe = this.safeUrl(url, baseUrl);
      if (!safe) return this.escapeHtml(alt);
      const titleAttr = title ? ` title="${this.escapeAttr(title)}"` : '';
      return `<img class="md-img" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${this.escapeAttr(safe)}" alt="${this.escapeAttr(alt)}"${titleAttr} />`;
    });

    // Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label, url, title) => {
      const safe = this.safeUrl(url, baseUrl);
      if (!safe) return label;
      const titleAttr = title ? ` title="${this.escapeAttr(title)}"` : '';
      return `<a class="md-a" href="${this.escapeAttr(safe)}" target="_blank" rel="noopener noreferrer ugc"${titleAttr}>${label}</a>`;
    });

    // Bold: **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_ — careful not to match inside words
    // (so file_name_here doesn't render as fileNAMEHEREfile).
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>');

    // Hard line break: two spaces + newline (we already joined on
    // spaces in the paragraph collector, so this is a no-op in the
    // common case — harmless to keep for callers that pass it in).
    s = s.replace(/  \n/g, '<br />');

    // Reinsert protected code spans.
    s = s.replace(/\x00CODE(\d+)\x00/g, (_m, n) => codeStash[Number(n)] ?? '');

    return s;
  }

  // ------ Blocks ------

  private renderCodeBlock(code: string, lang: string): string {
    const langClass = lang ? ` lang-${this.escapeAttr(lang)}` : '';
    return `<pre class="md-pre${langClass}"><code class="md-code-block">${this.escapeHtml(code)}</code></pre>`;
  }

  private splitTableRow(line: string): string[] {
    // Strip the leading/trailing pipes if present, then split on |.
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }

  private renderTable(header: string[], body: string[][], baseUrl: string | null): string {
    const head = header.map((c) => `<th>${this.renderInline(c, baseUrl)}</th>`).join('');
    const rows = body
      .map((row) => '<tr>' + row.map((c) => `<td>${this.renderInline(c, baseUrl)}</td>`).join('') + '</tr>')
      .join('');
    return `<table class="md-table scroll-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ------ Sanitizers ------

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeAttr(s: string): string {
    return this.escapeHtml(s);
  }

  /**
   * Returns a safe URL string or null if the URL must be rejected.
   *
   * Rules:
   *   - absolute http(s) and mailto are passed through.
   *   - relative URLs are joined with `baseUrl` if provided, otherwise
   *     returned as-is (the browser will resolve them against the
   *     current document — harmless inside our app shell).
   *   - javascript:, data:, vbscript:, file: are rejected outright —
   *     the README is third-party content and we never want to
   *     navigate to an arbitrary scheme on a user click.
   */
  private safeUrl(url: string, baseUrl: string | null): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;

    // Reject dangerous schemes. We check both literal and
    // case-folded forms — older XSS lists use mixed case
    // (`JavaScript:`, `JaVaScRiPt:`) which old browsers still
    // interpret as the JS scheme.
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('vbscript:') ||
      lower.startsWith('file:')
    ) {
      return null;
    }

    // Anchor link inside the README — keep as fragment.
    if (trimmed.startsWith('#')) return trimmed;

    // Absolute URL — keep as-is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;

    // Protocol-relative (//cdn.example.com/x) — upgrade to https.
    if (trimmed.startsWith('//')) return 'https:' + trimmed;

    // Relative — join against baseUrl when we have one.
    if (baseUrl) {
      try {
        return new URL(trimmed, baseUrl).toString();
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
}
