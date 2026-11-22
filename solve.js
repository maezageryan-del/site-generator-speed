// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// An original implementation of the makefun-site spec (the kit's vendor README): the same
// answers on every case, reached faster. The pipeline runs in the spec's order — sources,
// front matter, permalinks, Markdown, collections, tags, layouts, report — and the speed
// comes from compiled templates, bulk inline rendering, memoised slugs, a fused Markdown
// pass and one-pass front-matter parsing, never from cutting a corner of the spec.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters
 * other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at
 * the cut dropped), and "untitled" when nothing is left. Pure-ASCII input skips the
 * normalisation pass: NFKD is the identity on ASCII and ASCII holds no combining marks.
 */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace, counted without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const KEY_RE = /^[a-z_]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it
 * is refused. `text` has "\n" line ends. Only the front-matter lines are split; the body is
 * sliced out whole, never split and re-joined.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeStart = -1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmText = text.slice(nl0 === -1 ? text.length : nl0 + 1, closeStart);
  const lines = fmText === '' ? [] : fmText.split('\n');
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const c = line.indexOf(':');
    if (c <= 0) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, c);
    if (!KEY_RE.test(key)) return { error: `line ${j + 2} is not "key: value"` };
    let raw;
    if (c === line.length - 1) raw = '';
    else if (line.charCodeAt(c + 1) === 32) raw = line.slice(c + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at either end. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6) return null;
  if (j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  let e = line.length;
  while (e > k && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === k) return null;
  return { depth: j, text: line.slice(k, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const p = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : 0;
  if (p === 0) return false;
  for (let i = p; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A bullet item's text when `line` opens one, else null. */
function bulletRest(line) {
  if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start and text when `line` opens one, else null. */
function orderedMatch(line) {
  let d = 0;
  while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), rest: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  if (n < 2 || n >= line.length) return false;
  const c = line.charCodeAt(n);
  return c !== 32 && c !== 9;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*[]/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. Plain runs between the markup
 * characters are escaped in bulk instead of one character at a time.
 */
function inline(s, link) {
  INLINE_RE.lastIndex = 0;
  if (!INLINE_RE.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const mt = INLINE_RE.exec(s);
    if (mt === null) {
      out.push(escapeHtml(s.slice(i)));
      break;
    }
    const nx = mt.index;
    if (nx > i) out.push(escapeHtml(s.slice(i, nx)));
    i = nx;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push(`<code>${escapeHtml(s.slice(i + 1, j))}</code>`);
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push(`<strong>${inline(s.slice(i + 2, j), link)}</strong>`);
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out.push(`<em>${inline(s.slice(i + 1, j), link)}</em>`);
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push(`<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`);
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
  return out.join('');
}

/**
 * `src` rendered in one pass (lexing and rendering fused, no token objects): its HTML
 * (each block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slug) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${body.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slug(h.text), ids);
        const html = inline(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 === 45 || c0 === 42) {
      const b = bulletRest(line);
      if (b !== null) {
        const items = [[trimLine(b)]];
        i++;
        while (i < lines.length) {
          const m = bulletRest(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        blocks.push(`<ul>\n${items.map((it) => `<li>${inline(it.join('\n'), link)}</li>\n`).join('')}</ul>`);
        continue;
      }
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedMatch(line);
      if (o !== null) {
        const items = [[trimLine(o.rest)]];
        const start = o.start;
        i++;
        while (i < lines.length) {
          const m = orderedMatch(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.rest)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        blocks.push(`${open}\n${items.map((it) => `<li>${inline(it.join('\n'), link)}</li>\n`).join('')}</ol>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function isSpaces(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src.slice(lineStart, open)) && isSpaces(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain `frames` (innermost last): its first name from
 * the nearest frame holding it, then own properties of the value so far.
 */
function lookup(frames, path) {
  for (let i = frames.length - 1; i >= 0; i--) {
    const vars = frames[i];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's nodes compiled to plain JavaScript: each template becomes one function
 * (frames, depth, out) whose control flow is the template's own, so a render pays no
 * per-node dispatch, no per-iteration closure and no fresh scope object per loop turn.
 * `R` is the per-case runtime: escape, textOf, lookup, truthy and the map of compiled
 * templates (filled before any render runs, so includes resolve through it).
 */
function compileNodes(nodes, gen) {
  for (const n of nodes) {
    if (n.kind === 'text') gen.code.push(`O.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var' || n.kind === 'raw') {
      const pi = gen.paths.length;
      gen.paths.push(n.path);
      gen.code.push(n.kind === 'var' ? `O.push(R.esc(R.txt(R.lk(F,P${pi}))));` : `O.push(R.txt(R.lk(F,P${pi})));`);
    } else if (n.kind === 'if') {
      const pi = gen.paths.length;
      gen.paths.push(n.path);
      gen.code.push(`if(R.truthy(R.lk(F,P${pi}))!==${n.not}){`);
      compileNodes(n.then, gen);
      if (n.else !== null) {
        gen.code.push('}else{');
        compileNodes(n.else, gen);
      }
      gen.code.push('}');
    } else if (n.kind === 'for') {
      const id = gen.ctr++;
      const pi = gen.paths.length;
      gen.paths.push(n.path);
      gen.code.push(`{const X${id}=R.lk(F,P${pi});if(Array.isArray(X${id})){const W${id}={};F.push(W${id});const L${id}={index:0,first:false,last:false,length:X${id}.length};for(let k${id}=0;k${id}<X${id}.length;k${id}++){W${id}[${JSON.stringify(n.name)}]=X${id}[k${id}];W${id}.loop=L${id};L${id}.index=k${id}+1;L${id}.first=k${id}===0;L${id}.last=k${id}===X${id}.length-1;`);
      compileNodes(n.body, gen);
      gen.code.push(`}F.pop();}}`);
    } else if (n.kind === 'include') {
      const id = gen.ctr++;
      gen.code.push(`if(D<8){const T${id}=R.tpl.get(${JSON.stringify(n.name)});if(T${id}!==undefined)T${id}(F,D+1,O);}`);
    }
  }
}

function compileTemplate(nodes, rt) {
  const gen = { code: [], paths: [], ctr: 0 };
  compileNodes(nodes, gen);
  const decls = gen.paths.map((p, i) => `const P${i}=${JSON.stringify(p)};`).join('');
  return new Function('R', `${decls}return function(F,D,O){${gen.code.join('')}};`)(rt);
}

/** The same nodes rendered by walking them (used only if code generation is unavailable). */
function renderNodes(nodes, F, D, O, rt) {
  for (const n of nodes) {
    if (n.kind === 'text') O.push(n.text);
    else if (n.kind === 'var') O.push(escapeHtml(textOf(lookup(F, n.path))));
    else if (n.kind === 'raw') O.push(textOf(lookup(F, n.path)));
    else if (n.kind === 'if') {
      const branch = truthy(lookup(F, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, F, D, O, rt);
    } else if (n.kind === 'for') {
      const xs = lookup(F, n.path);
      if (!Array.isArray(xs)) continue;
      const vars = {};
      F.push(vars);
      const loop = { index: 0, first: false, last: false, length: xs.length };
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        vars.loop = loop;
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderNodes(n.body, F, D, O, rt);
      }
      F.pop();
    } else if (n.kind === 'include') {
      const t = rt.tpl.get(n.name);
      if (t !== undefined && D < 8) t(F, D + 1, O);
    }
  }
}

// ---------------------------------------------------------------- the build

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = cardOf(s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-case memoisation only: nothing is carried from one case to the next.
  const slugMemo = new Map();
  const slug = (t) => {
    let s = slugMemo.get(t);
    if (s === undefined) {
      s = slugifyRaw(t);
      slugMemo.set(t, s);
    }
    return s;
  };
  const rt = { esc: escapeHtml, txt: textOf, lk: lookup, truthy, tpl: new Map() };
  const report = [];

  // Templates, parsed in code-unit order of their name. One that does not parse is
  // reported and left out, as if it were not there.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    let nodes;
    try {
      nodes = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      continue;
    }
    let fn;
    try {
      fn = compileTemplate(nodes, rt);
    } catch {
      fn = (F, D, O) => renderNodes(nodes, F, D, O, rt);
    }
    rt.tpl.set(name, fn);
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the checks run in order and the first one that fails
  // is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!rt.tpl.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered to HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = `${dir}\n${target}`;
      let hit = linkCache.get(key);
      if (hit === undefined) {
        let url;
        let bad = false;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) url = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) url = bySource.get(path).url + frag;
          else if (path !== null && staticPaths.has(path)) url = `${base}/${path}${frag}`;
          else {
            bad = true;
            url = target;
          }
        }
        hit = { url, bad };
        linkCache.set(key, hit);
      }
      if (hit.bad) broken.add(`broken-link ${s.path} -> ${target}`);
      return hit.url;
    };
    const md = renderMarkdown(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags, each slug once (the first spelling kept), in its own order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (seen.has(sl)) continue;
      seen.add(sl);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = rt.tpl.get(name);
    if (fn === undefined) return null;
    const O = [];
    fn([{ site, tags: allTags, recent, ...vars }], 0, O);
    return O.join('');
  };
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = sources.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
