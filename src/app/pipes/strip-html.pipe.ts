import { Pipe, PipeTransform } from '@angular/core';

/**
 * Strip HTML tags + decode common HTML entities from a string.
 *
 * # Why this exists
 *
 * The npm registry's `description` field is a free-form string, and a
 * meaningful slice of packages — particularly older ones — paste the
 * opening banner of their README straight into it: `<div align="center">
 * <img src="..."> <br> <h1>ngx-toastr</h1>` etc. Rendering that via a
 * standard Angular interpolation (which escapes HTML for XSS safety)
 * dumps the literal markup as text, which looks broken.
 *
 * # Why a pipe, not a service or component utility
 *
 * - **Pure pipe** = Angular memoizes the result for a given input, so
 *   the regex work runs exactly once per unique description per change
 *   detection cycle. Free perf win over a getter / template function.
 * - **Reusable** = the same junk appears in other places we display
 *   npm descriptions (favorites list, history page, autocomplete
 *   subtitle). Co-locating with the consuming component would force a
 *   later refactor.
 * - **No DI** = the transform is a pure string→string operation, so
 *   keeping it as a stateless pipe avoids pulling in a whole service
 *   instance per usage.
 *
 * # Why regex over DOMParser
 *
 * `DOMParser` would handle entities and edge cases more thoroughly
 * but is browser-only — calling it during SSR prerendering crashes
 * (no `window`). A regex strip + manual decode of the half-dozen
 * entities npm package authors actually use is good enough, runs in
 * both render targets, and adds zero kB beyond the pipe itself.
 *
 * # What it strips and decodes
 *
 *   - All tags: `<div>`, `<img />`, `<br>`, `<h1>`, `<a href="...">`, etc.
 *   - HTML comments: `<!-- ... -->`
 *   - Named entities: &amp; &lt; &gt; &quot; &apos; &#39; &nbsp;
 *   - Numeric entities: &#39; &#x27; (decimal + hex)
 *   - Collapsed whitespace (multi-space, newlines → single space)
 *
 * # What it intentionally doesn't do
 *
 *   - Sanitize for safe HTML rendering. If you need that, use Angular's
 *     `DomSanitizer.bypassSecurityTrustHtml` — but for descriptions
 *     we want PLAIN TEXT, not safe HTML, so this pipe is the right tool.
 *   - Decode the full HTML entity set. There are ~250 named entities;
 *     the seven below cover everything I've ever seen in an npm
 *     `description`. Add more on demand rather than shipping all of
 *     them upfront.
 */
@Pipe({
  name: 'stripHtml',
  standalone: true,
  pure: true
})
export class StripHtmlPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';

    // 1. Drop HTML comments first — otherwise `<!-- a -->` would leave
    //    " a " in the output once the tag-stripper passes over it.
    let out = value.replace(/<!--[\s\S]*?-->/g, ' ');

    // 2. Strip all tags. The `[^>]*` is greedy-safe because HTML can't
    //    legally contain `>` inside an attribute value without quoting,
    //    and npm descriptions don't ship XHTML/SVG.
    out = out.replace(/<[^>]*>/g, ' ');

    // 2b. Strip ORPHAN opening tags — `<a href="..."` with no closing
    //     `>`. npm truncates descriptions at ~280 chars, which routinely
    //     cuts mid-tag for packages that paste a README banner here
    //     (ngx-toastr is the canonical example: its description ends
    //     with `<a href="https://www.npmjs.org/package/` and the rest
    //     never made it into the registry). Without this pass the
    //     step-2 regex leaves the orphan tag intact and it renders as
    //     literal HTML to the user. Matching `<` + letter + non-`>`
    //     run + end-of-string avoids touching `<` that appears in
    //     legit prose (e.g. "use < 3 characters").
    out = out.replace(/<[a-z][^<>]*$/i, '');
    // 2c. Same for an orphan closing tag fragment at start ("...attr"`>
    //     leftover from the previous truncation). Rare, but cheap.
    out = out.replace(/^[^<>]*>\s*/, '');

    // 3. Decode the named entities npm authors actually use.
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // 4. Decode numeric entities (decimal + hex). Caps the codepoint at
    //    0x10FFFF (the Unicode maximum) so malformed input can't blow
    //    up `String.fromCodePoint` with a RangeError.
    out = out.replace(/&#(\d+);/g, (_, dec: string) => {
      const cp = Number(dec);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
    out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });

    // 5. Collapse runs of whitespace (newlines, tabs, multi-space) into
    //    single spaces and trim. Tag-stripping leaves a lot of these
    //    behind — e.g. `<div> <img> <h1>foo</h1>` becomes
    //    `    foo` before this step.
    return out.replace(/\s+/g, ' ').trim();
  }
}
