// parse.js — a dependency-free CommonMark 0.31.2 + GFM renderer whose output
// matches marked 18.1.3 with default options, written from scratch.
// Single public export: parse(markdown) -> HTML string.
// Design: line-oriented block parser (container stack + leaf starts, CommonMark
// algorithm) followed by a delimiter-stack inline parser. No regexes in the
// hot paths; output is built in arrays and joined once.


// ---- character classes -------------------------------------------------
function isSpace(c) { // ASCII space/tab/newline family
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isUniSpace(c) { // CommonMark "Unicode whitespace": Zs + tab/LF/FF/CR
  if (c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32) return true;
  return c === 0x85 || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x202F || c === 0x205F || c === 0x3000;
}
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT.has(String.fromCharCode(c));
  return PUNCT_RE.test(String.fromCodePoint(c));
}
const PUNCT_RE = /[\p{P}\p{S}]/u; // CommonMark punctuation: P or S categories
const punctCache = new Map();
function isPunct(ch) { // ch is a single code point string
  const c = ch.codePointAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  let v = punctCache.get(c);
  if (v === undefined) { v = PUNCT_RE.test(ch); punctCache.set(c, v); }
  return v;
}
function isAsciiPunctChar(ch) { return ch.length === 1 && ASCII_PUNCT.has(ch); }
function isAlphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnumCode(c) { return (c >= 48 && c <= 57) || isAlphaCode(c); }
function isSchemeCode(c) { return isAlnumCode(c) || c === 43 || c === 46 || c === 45; }
function isDomainCode(c) { return isAlnumCode(c) || c === 45; }
// email local-part chars: A-Za-z0-9.!#$%&'*+/=?^_`{|}~-
function isEmailCode(c) {
  if (isAlnumCode(c)) return true;
  return c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
// src starts with http:// or https:// (case-insensitive) at i
function isHttpStart(src, i) {
  if (i + 7 > src.length) return false;
  const a = src.charCodeAt(i), b = src.charCodeAt(i + 1), c = src.charCodeAt(i + 2), d = src.charCodeAt(i + 3);
  if (!((a === 104 || a === 72) && (b === 116 || b === 84) && (c === 116 || c === 84) && (d === 112 || d === 80))) return false;
  if (src[i + 4] === ':' && src[i + 5] === '/' && src[i + 6] === '/') return true;
  const e = src.charCodeAt(i + 4);
  return (e === 115 || e === 83) && src[i + 5] === ':' && src[i + 6] === '/' && src[i + 7] === '/';
}
// tag/attribute name start: [A-Za-z_:]
function isNameStartCode(c) { return isAlphaCode(c) || c === 95 || c === 58; }
// attribute name rest: [A-Za-z0-9_.:-]
function isNameCode(c) { return isAlnumCode(c) || c === 95 || c === 46 || c === 58 || c === 45; }
// unquoted attribute value may not contain space " ' = < > `
function isUnquotedValCode(c) {
  return c !== 32 && c !== 9 && c !== 10 && c !== 34 && c !== 39 && c !== 61 && c !== 60 && c !== 62 && c !== 96;
}

// Resolve backslash escapes (\ + ASCII punctuation -> the punctuation).
function resolveEscapes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunctChar(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// ---- escaping ----------------------------------------------------------
// Find one entity starting at s[i] === '&'. Returns [decodedString,
// length, isNumeric] or null when no entity-like sequence starts here.
// Named entities are reported with decodedString null (they are kept
// verbatim); only numeric entities decode.
function entityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // '#'
    let j = i + 2, hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
              : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === start || j >= n || s[j] !== ';') return null;
    // numeric entities have at most 7 decimal or 6 hex digits
    if ((hex && j - start > 6) || (!hex && j - start > 7)) return null;
    const num = parseInt(s.slice(start, j), hex ? 16 : 10);
    const cp = (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) ? 0xFFFD : num;
    return [String.fromCodePoint(cp), j + 1 - i, true];
  }
  // named: &[A-Za-z0-9_]+; (known or not: kept verbatim)
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === i + 1 || j >= n || s[j] !== ';') return null;
  return [null, j + 1 - i, false];
}

// Render plain text: named entities pass through verbatim, numeric
// entities decode (and the decoded char is escaped if it is & < > " ').
// An & that starts no entity-like sequence becomes &amp;.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      const e = entityAt(s, i);
      if (e) {
        if (e[2]) {
          const c = e[0];
          out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c;
        } else out += s.slice(i, i + e[1]);
        i += e[1] - 1;
      } else out += '&amp;';
    } else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape for attribute values / hrefs: entities are NOT decoded; an & that
// starts an entity-like sequence is left alone, other & becomes &amp;.
function escAttr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      const e = entityAt(s, i);
      if (e) { out += s.slice(i, i + e[1]); i += e[1] - 1; }
      else out += '&amp;';
    } else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape for code content: every & < > " ' is escaped, no entity handling.
function escCode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// href: encodeURI (with % left alone), then entity-aware attribute escaping.
function cleanHref(href) {
  return escAttr(encodeURI(href).replace(/%25/g, '%'));
}

// ---- link reference definitions ----------------------------------------
// Normalize a link label: collapse whitespace runs (incl. newlines) to one
// space, trim, Unicode case-fold (ẞ/ß fold to ss).
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().replace(/[\u1E9E\u00DF]/g, 'ss').toLowerCase();
}

// Parse one link reference definition starting at text[i] (which must be
// '['). Returns {dest, title, end} or null. title may be null.
function parseLinkDef(text, i) {
  const n = text.length;
  // label: [ ... ] with balanced brackets, 1..999 chars, kept raw
  // (backslash escapes are NOT resolved in labels)
  let j = i + 1, label = '', depth = 0;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunctChar(text[j + 1])) { label += text[j]; label += text[j + 1]; j += 2; continue; }
    if (ch === '[') return null; // a label may not contain an unescaped [
    if (ch === ']') {
      if (depth === 0) break;
      depth--; label += ch; j++; continue;
    }
    label += ch; j++;
  }
  if (j >= n || text[j] !== ']' || label.length === 0 || label.length > 999) return null;
  if (normalizeLabel(label) === '') return null;
  j++; // past ]
  if (j >= n || text[j] !== ':') return null;
  j++;
  // skip spaces/tabs/newlines (at most one newline? spec: optional spaces/tabs/newlines)
  while (j < n && isSpace(text.charCodeAt(j))) j++;
  if (j >= n) return null;
  // destination
  let dest = '';
  if (text[j] === '<') {
    j++;
    const start = j;
    while (j < n && text[j] !== '>' && text[j] !== '\n' && text[j] !== '<') {
      if (text[j] === '\\' && j + 1 < n && isAsciiPunctChar(text[j + 1])) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j]; j++;
    }
    if (j >= n || text[j] !== '>') return null;
    j++;
    void start;
  } else {
    // bare destination: no spaces/control chars, balanced parens
    let depth = 0;
    while (j < n) {
      const ch = text[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) break;
      if (ch === '\\' && j + 1 < n && isAsciiPunctChar(text[j + 1])) { dest += text[j + 1]; j += 2; continue; }
      if (ch === '(') { depth++; dest += ch; j++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--; dest += ch; j++; continue;
      }
      dest += ch; j++;
    }
    if (dest.length === 0 || depth !== 0) return null;
  }
  // After the destination: optional spaces/tabs, then an optional title
  // (on this line or the next), then only spaces/tabs to the line end.
  // A title on the same line must be separated from the destination by
  // whitespace.
  let k = j;
  let ws = 0;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) { k++; ws++; }
  let title = null;
  if (k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    if (ws === 0) return null;
    const t = parseTitle(text, k);
    if (!t) return null;
    title = t.title; k = t.end;
    while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
    if (k < n && text[k] !== '\n') return null;
    return { label: normalizeLabel(label), dest, title, end: k < n ? k + 1 : k };
  }
  if (k < n && text[k] === '\n') {
    // the title may sit on the next line; if it is malformed or followed
    // by junk, it is not a title at all and the definition ends here
    let k2 = k + 1;
    while (k2 < n && (text[k2] === ' ' || text[k2] === '\t')) k2++;
    if (k2 < n && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) {
      const t = parseTitle(text, k2);
      if (t) {
        let k3 = t.end;
        while (k3 < n && (text[k3] === ' ' || text[k3] === '\t')) k3++;
        if (k3 >= n || text[k3] === '\n') {
          return { label: normalizeLabel(label), dest, title: t.title, end: k3 < n ? k3 + 1 : k3 };
        }
      }
      return { label: normalizeLabel(label), dest, title: null, end: k + 1 };
    }
    return { label: normalizeLabel(label), dest, title, end: k + 1 };
  }
  if (k < n) return null; // junk after the destination
  return { label: normalizeLabel(label), dest, title, end: k };
}

// Parse a link title starting at text[i] ('"' or "'" or '(').
// Returns {title, end} or null. Titles may span lines; a paren title may
// not contain unescaped parens.
function parseTitle(text, i) {
  const n = text.length;
  const open = text[i], close = open === '(' ? ')' : open;
  let k = i + 1, t = '';
  while (k < n && text[k] !== close) {
    const ch = text[k];
    if (ch === '\\' && k + 1 < n && isAsciiPunctChar(text[k + 1])) { t += text[k + 1]; k += 2; continue; }
    if (open === '(' && (ch === '(' || ch === ')')) return null;
    t += ch; k++;
  }
  if (k >= n) return null;
  return { title: t, end: k + 1 };
}

// Extract leading link reference definitions from a paragraph's text.
// Adds them to refs (first definition wins) and records the stored labels
// in out (so a later re-extraction can remove them first). Returns the
// remaining text (after the definitions), or '' if the paragraph consisted
// only of definitions.
function extractRefs(text, refs, out) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    // skip up to 3 spaces at line start, and blank lines between definitions
    let j = i;
    while (j < n) {
      const ch = text[j];
      if (ch === ' ' || ch === '\t') { j++; continue; }
      if (ch === '\n') { j++; continue; }
      break;
    }
    if (j >= n) { i = j; break; }
    // a definition must start at a line start (after <=3 spaces) with '['
    // count leading spaces on this line
    let sp = 0, p = j;
    // find line start
    let ls = j;
    while (ls > 0 && text[ls - 1] !== '\n') ls--;
    let spc = 0;
    for (let q = ls; q < j; q++) spc += text[q] === '\t' ? 4 - (spc % 4) : 1;
    if (spc > 3 || text[j] !== '[') break;
    const d = parseLinkDef(text, j);
    if (!d) break;
    if (!refs.has(d.label)) { refs.set(d.label, { dest: d.dest, title: d.title }); if (out) out.push(d.label); }
    i = d.end;
    void sp; void p;
  }
  return text.slice(i).replace(/^\n+/, '');
}

// ---- block parsing -----------------------------------------------------
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

function parseBlocks(src) {
  const refs = new Map();
  const srcEndsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  // a trailing newline does not create a final (empty) line
  if (srcEndsWithNL) lines.pop();
  const root = { t: 'doc', children: [] };
  const open = [root];
  let sawBlank = false;
  let idx = 1, allMatched = true;
  let s = '', pos = 0, col = 0;
  // absolute column where the innermost list item matched on this line
  // starts its content (0 when no item matched). Tab widths in the
  // line's content are measured from here, not from column 0: a tab
  // after `>` inside an item is narrower than the absolute column says.
  let itemContentCol = 0;

  function countIndent() {
    let c = col, p = pos;
    while (p < s.length) {
      const ch = s[p];
      if (ch === ' ') { c++; p++; }
      else if (ch === '\t') { c += 4 - (c % 4); p++; }
      else break;
    }
    return c - col;
  }
  // Leading-whitespace columns with tab widths measured from the column
  // relative to the innermost list item's content start (itemContentCol),
  // not the absolute column. A tab after `>` inside an item is narrower
  // than the absolute column says, so it must not count as 4 columns
  // of indent (which would wrongly trigger indented code / the 4-column
  // strip in a paragraph continuation).
  function localIndent() {
    let c = col - itemContentCol, p = pos, n = 0;
    while (p < s.length) {
      const ch = s[p];
      if (ch === ' ') { c++; p++; n++; }
      else if (ch === '\t') { const w = 4 - (c % 4); c += w; p++; n += w; }
      else break;
    }
    return n;
  }
  // Consume whitespace until col reaches target (partial tab -> spaces).
  function advanceTo(target) {
    while (col < target && pos < s.length) {
      const ch = s[pos];
      if (ch === ' ') { pos++; col++; }
      else if (ch === '\t') {
        const w = 4 - (col % 4);
        if (col + w <= target) { pos++; col += w; }
        else {
          const keep = col + w - target;
          s = s.slice(0, pos) + ' '.repeat(keep) + s.slice(pos + 1);
          col = target;
        }
      } else break;
    }
  }
  // Skip up to maxCols columns of whitespace. Returns {p, c} or null when
  // the whitespace exceeds maxCols before a non-ws char.
  function wsEnd(maxCols) {
    let p = pos, c = col;
    while (p < s.length) {
      const ch = s[p];
      if (ch === ' ') { if (c - col >= maxCols) return null; p++; c++; }
      else if (ch === '\t') {
        const w = 4 - (c % 4);
        if (c - col + w > maxCols) return null;
        p++; c += w;
      } else break;
    }
    return { p, c };
  }
  // Remove up to `indent` leading whitespace characters from the
  // current line (a tab counts as one character), stopping at the
  // first non-whitespace character. This is how marked strips a
  // fenced code block's indent: a tab inside the indent is removed
  // whole (``  ``` `` + `\tfoo` gives `foo`, not `  foo`), while a
  // tab past the indent is kept. Column-based advanceTo would
  // partially consume the tab and leave spaces.
  function stripFenceIndent(indent) {
    let n = 0;
    while (n < indent && pos < s.length) {
      const ch = s[pos];
      if (ch === ' ') { pos++; col++; n++; }
      else if (ch === '\t') { col += 4 - (col % 4); pos++; n++; }
      else break;
    }
  }
  function isBlankFrom(p) {
    for (let i = p; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
    return true;
  }
  function rest() { return s.slice(pos); }
  // expand tabs in the leading whitespace of a paragraph line, using
  // the column at which the text starts (a tab after a blockquote
  // marker expands to the next tab stop: `>   \tfoo` becomes
  // `    foo`, 4 spaces). Only inside a container (startCol > 0):
  // a top-level tab stays literal (`a\n\tb` keeps the tab).
  function expandLeadTabs(text, startCol) {
    if (startCol <= 0) return text;
    let j = 0;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (j === 0 || text.indexOf('\t') < 0 || text.indexOf('\t') >= j) return text;
    let out = '';
    let c = startCol;
    for (let k = 0; k < j; k++) {
      if (text[k] === ' ') { out += ' '; c++; }
      else { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; }
    }
    return out + text.slice(j);
  }
  function addChild(node) {
    const parent = open[open.length - 1];
    if (parent.t === 'item' && parent.children.length > 0 && sawBlank) parent.list.loose = true;
    if (parent.t === 'list' && parent.children.length > 0 && sawBlank) parent.loose = true;
    parent.children.push(node);
    return node;
  }
  function pushOpen(node) { addChild(node); open.push(node); return node; }
  function finalizePara(para) {
    // A definition's title can arrive on a later line, so a definition
    // stored by an earlier (incomplete) extraction must be removed and
    // re-extracted from the full text each time.
    if (para.defLabels) for (const lab of para.defLabels) refs.delete(lab);
    para.defLabels = [];
    const text = para.lines.join('\n');
    para.text = extractRefs(text, refs, para.defLabels);
    para.empty = para.text === '';
  }
  function finalize(block) {
    if (block.t === 'para') finalizePara(block);
    else if (block.t === 'fence' || block.t === 'code') {
      block.text = block.lines.length ? block.lines.join('\n') + '\n' : '';
      if (block.t === 'code') {
        // strip trailing blank lines
        while (block.text.endsWith('\n\n')) block.text = block.text.slice(0, -1);
        if (block.text === '\n') block.text = '';
      }
    } else if (block.t === 'html') {
      // HTML blocks keep their lines verbatim; a trailing newline is kept
      // only when the block did not end at a blank line, did not end
      // because a container closed, and its last line had a newline.
      // A block that ended at its end marker loses the trailing newline
      // when the next source line is blank.
      block.text = block.lines.join('\n');
      let keepNL = !block.blankEnded && !block.parentClosed && block.trailingNL;
      if (keepNL && block.ended && typeof block.lastLine === 'number') {
        const nl = block.lastLine + 1;
        if (nl < lines.length && lines[nl] === '') keepNL = false;
      }
      if (keepNL) block.text += '\n';
    } else if (block.t === 'para2') { /* unused */ }
    if (block.t === 'para' && block.empty) {
      // remove from parent's children
      const parent = block.parent;
      if (parent) {
        const i = parent.children.indexOf(block);
        if (i >= 0) parent.children.splice(i, 1);
      }
    }
  }
  function closeTo(idx) {
    for (let i = open.length - 1; i >= idx; i--) {
      const b = open[i];
      // an HTML block keeps its trailing newline only when its parent
      // stays open (it did not end because a container closed)
      if (b.t === 'html') b.parentClosed = (i - 1 >= idx);
      finalize(b);
    }
    open.length = idx;
  }

  // --- block-start checks (pure: they read s/pos/col but do not mutate) ---
  function tryFence() {
    const w = wsEnd(3);
    if (!w) return null;
    const ch = s[w.p];
    if (ch !== '`' && ch !== '~') return null;
    let p = w.p, len = 0;
    while (s[p] === ch) { p++; len++; }
    if (len < 3) return null;
    let info = s.slice(p);
    if (ch === '`' && info.indexOf('`') >= 0) return null;
    info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    // the info string is the first word; backslash escapes resolve
    const sp = info.search(/[ \t]/);
    if (sp >= 0) info = info.slice(0, sp);
    info = resolveEscapes(info);
    return { ch, len, info, p, c: w.c + len, indent: w.c - col };
  }
  function closeFence(fence) {
    const w = wsEnd(3);
    if (!w) return false;
    if (s[w.p] !== fence.fence) return false;
    let p = w.p, len = 0;
    while (s[p] === fence.fence) { p++; len++; }
    if (len < fence.len) return false;
    return isBlankFrom(p);
  }
  function tryAtx() {
    const w = wsEnd(3);
    if (!w) return null;
    let p = w.p, level = 0;
    while (s[p] === '#') { p++; level++; }
    if (level === 0 || level > 6) return null;
    if (p < s.length && s[p] !== ' ' && s[p] !== '\t') return null;
    let rest = s.slice(p);
    // strip a closing run of #s preceded by space/tab
    const m = /[ \t]+#+[ \t]*$/.exec(rest);
    let content = m ? rest.slice(0, m.index) : rest;
    content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { level, content };
  }
  function tryHr() {
    const w = wsEnd(3);
    if (!w) return null;
    const ch = s[w.p];
    if (ch !== '-' && ch !== '_' && ch !== '*') return null;
    let p = w.p, count = 0;
    while (p < s.length) {
      const c = s[p];
      if (c === ch) { count++; p++; }
      else if (c === ' ' || c === '\t') p++;
      else return null;
    }
    return count >= 3;
  }
  function tryBlockquote() {
    const w = wsEnd(3);
    if (!w || s[w.p] !== '>') return null;
    let p = w.p + 1, c = w.c + 1;
    if (s[p] === ' ') { p++; c++; }
    else if (s[p] === '\t') { c++; /* tab partially consumed: 1 col */ }
    // the tab after > expands from the column relative to the
    // innermost enclosing container's content start (the column at
    // entry), not the absolute column
    const tabKeep = s[w.p + 1] === '\t' ? 4 - (((w.c + 1) - col) % 4) - 1 : 0;
    return { p, c, tabPartial: s[w.p + 1] === '\t', tabKeep };
  }
  function tryList() {
    const w = wsEnd(3);
    if (!w) return null;
    let p = w.p;
    const ch = s[p];
    let ordered = false, start = null, delim = '', bullet = '', mlen = 0;
    if (ch === '-' || ch === '+' || ch === '*') {
      bullet = ch; mlen = 1;
    } else if (ch >= '0' && ch <= '9') {
      let q = p, digits = 0;
      while (q < s.length && s[q] >= '0' && s[q] <= '9') { q++; digits++; }
      if (digits === 0 || digits > 9) return null;
      if (s[q] !== '.' && s[q] !== ')') return null;
      ordered = true; delim = s[q];
      start = parseInt(s.slice(p, q), 10);
      mlen = q + 1 - p;
    } else return null;
    const after = p + mlen;
    if (after >= s.length) {
      // empty item: marker + EOL
      return { ordered, start, delim, bullet, contentIndent: w.c + mlen + 1, empty: true, after, afterCol: w.c + mlen };
    }
    const ac = s[after];
    if (ac !== ' ' && ac !== '\t') return null;
    // count whitespace columns after the marker
    let c = w.c + mlen, q = after, ws = 0;
    while (q < s.length) {
      const ch2 = s[q];
      if (ch2 === ' ') { ws++; c++; q++; }
      else if (ch2 === '\t') { const tw = 4 - (c % 4); ws += tw; c += tw; q++; }
      else break;
    }
    if (q >= s.length) {
      return { ordered, start, delim, bullet, contentIndent: w.c + mlen + 1, empty: true, after, afterCol: w.c + mlen };
    }
    let contentIndent;
    if (ws >= 1 && ws <= 4) contentIndent = w.c + mlen + ws;
    else contentIndent = w.c + mlen + 1;
    return { ordered, start, delim, bullet, contentIndent, empty: false, after, afterCol: w.c + mlen };
  }
// Validate the attributes of a tag starting just after its name in str at
// position j. Returns the index just past the closing '>' (or '/>'), or -1
// when the tag is malformed. Closing tags allow only whitespace before '>'.
function validTagAttrs(str, j, closing) {
  const n = str.length;
  if (closing) {
    while (j < n && isSpace(str.charCodeAt(j))) j++;
    return (j < n && str[j] === '>') ? j + 1 : -1;
  }
  while (j < n) {
    let k = j;
    while (k < n && isSpace(str.charCodeAt(k))) k++;
    if (k >= n) return -1;
    if (str[k] === '>') return k + 1;
    if (str[k] === '/' && k + 1 < n && str[k + 1] === '>') return k + 2;
    if (k !== j && !isNameStartCode(str.charCodeAt(k))) return -1;
    if (k === j) return -1;
    j = k;
    if (!isNameStartCode(str.charCodeAt(j))) return -1;
    j++;
    while (j < n && isNameCode(str.charCodeAt(j))) j++;
    k = j;
    while (k < n && isSpace(str.charCodeAt(k))) k++;
    if (k < n && str[k] === '=') {
      k++;
      while (k < n && isSpace(str.charCodeAt(k))) k++;
      if (k >= n) return -1;
      if (str[k] === '"' || str[k] === "'") {
        const q = str[k]; k++;
        const e = str.indexOf(q, k);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        if (!isUnquotedValCode(str.charCodeAt(k))) return -1;
        j = k;
        while (j < n && isUnquotedValCode(str.charCodeAt(j))) j++;
      }
    }
    // no value: j stays after the attribute name; the loop skips ws
  }
  return -1;
}

function tryHtml() {
    const w = wsEnd(3);
    if (!w) return null;
    const p = w.p;
    if (s[p] !== '<') return null;
    const low = s.slice(p, p + 10).toLowerCase();
    if (low.startsWith('<!--')) return { type: 2, end: '-->' };
    if (low.startsWith('<?')) return { type: 3, end: '?>' };
    if (low.startsWith('<![cdata[')) return { type: 5, end: ']]>' };
    if (low.startsWith('<!') && p + 2 < s.length && isAlphaCode(s.charCodeAt(p + 2))) return { type: 4, end: '>' };
    // tag name
    let q = p + 1, closing = false;
    if (s[q] === '/') { closing = true; q++; }
    if (q >= s.length || !isAlphaCode(s.charCodeAt(q))) return null;
    const nameStart = q;
    while (q < s.length && isDomainCode(s.charCodeAt(q))) q++;
    const name = s.slice(nameStart, q).toLowerCase();
    const after = s[q];
    if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/' && after !== '\n') return null;
    if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
      return { type: 1, end: '</' + name };
    }
    if (BLOCK_TAGS.has(name)) return { type: 6, end: null };
    // type 7: a complete, well-formed open/close tag on this line, and
    // nothing else (the tag may not span lines here)
    const tagEnd = validTagAttrs(s, q, closing);
    if (tagEnd < 0) return null;
    if (isBlankFrom(tagEnd)) return { type: 7, end: null };
    return null;
  }
  function htmlEnded(blk, line) {
    if (blk.htmlType === 1) return line.toLowerCase().indexOf(blk.htmlEnd) >= 0;
    if (blk.htmlType === 2) return line.indexOf('-->') >= 0;
    if (blk.htmlType === 3) return line.indexOf('?>') >= 0;
    if (blk.htmlType === 4) return line.indexOf('>') >= 0;
    if (blk.htmlType === 5) return line.indexOf(']]>') >= 0;
    return false;
  }
  function setextLevel() {
    const w = wsEnd(3);
    if (!w) return 0;
    let p = w.p;
    const ch = s[p];
    if (ch !== '=' && ch !== '-') return 0;
    while (p < s.length && s[p] === ch) p++;
    if (!isBlankFrom(p)) return 0;
    return ch === '=' ? 1 : 2;
  }
  // Does the open paragraph sit inside a list item?
  function inListItem() {
    for (let k = open.length - 1; k >= 1; k--) if (open[k].t === 'item') return true;
    return false;
  }
  // Is the current line a lazy paragraph continuation (i.e. does it NOT
  // start a block that can interrupt a paragraph)? Setext lines are
  // handled by the caller.
  function lazyContinuation() {
    if (tryFence()) return false;
    if (tryAtx()) return false;
    if (tryHr()) return false;
    if (tryBlockquote()) return false;
    const li = tryList();
    if (li && !li.empty && (!li.ordered || li.start === 1 || inListItem())) return false;
    const h = tryHtml();
    if (h && h.type !== 7) return false;
    return true;
  }
  // Does the current line (from the container-failure point) start a
  // block that closes a fenced code block whose container did not match?
  // Like lazyContinuation but a list item interrupts unconditionally
  // (any item, empty or ordered start != 1): marked closes the fence
  // and reprocesses the line as a new block. Plain text, setext lines
  // and HTML type 7 stay fence content.
  function fenceStartsBlock() {
    if (tryFence()) return true;
    if (tryAtx()) return true;
    if (tryHr()) return true;
    if (tryBlockquote()) return true;
    if (tryList()) return true;
    const h = tryHtml();
    if (h && h.type !== 7) return true;
    return false;
  }
  // The content of a lazy continuation line: strip the innermost unmatched
  // list item's content indent, then strip 4 more columns when the
  // remaining indent is at least 4 (the indented-code amount). When the
  // line has less indent than the item's (the item did not match), the
  // spaces are kept: the line is a lazy continuation, not at the item's
  // content start.
  function lazyLine() {
    let base = 0;
    for (let k = open.length - 1; k >= idx; k--) {
      if (open[k].t === 'item') { base = open[k].indent; break; }
    }
    if (base > 0 && countIndent() >= base) advanceTo(col + base);
    if (countIndent() >= 4) advanceTo(col + 4);
    return expandLeadTabs(rest(), col);
  }
  // Split a table row line into cells (unescaped | splits; leading/trailing
  // | removed; cells trimmed).
  function splitRow(line) {
    const cells = [];
    let cur = '', i = 0;
    // skip leading spaces then optional leading |
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] === '|') i++;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    // trailing: if the line ended with | (after spaces), the last cell is dropped
    let tail = cur;
    if (/^[ \t]*$/.test(tail)) { /* line ended with |: drop empty trailing cell */ }
    else cells.push(tail.trim());
    return cells;
  }
  function tryTableDelim(para) {
    const w = wsEnd(3);
    if (!w) return null;
    // delimiter row: cells of :?-{1,}:? separated by |, optional outer |
    let p = w.p;
    const line = s.slice(p);
    if (line.indexOf('-') < 0) return null;
    const cells = splitRow(line);
    if (cells.length === 0) return null;
    const align = [];
    for (const cell of cells) {
      const m = /^(:?)-+(:?)$/.exec(cell);
      if (!m) return null;
      align.push(m[1] && m[2] ? 'center' : m[1] ? 'left' : m[2] ? 'right' : null);
    }
    // header is the paragraph's last line (after ref extraction)
    const headerText = para.text;
    const headerLines = headerText.split('\n');
    const headerCells = splitRow(headerLines[headerLines.length - 1]);
    if (headerCells.length !== cells.length) return null;
    return { align, headerCells, headerLines };
  }

  // --- main line loop ---
  for (let li = 0; li < lines.length; li++) {
    s = lines[li]; pos = 0; col = 0;
    itemContentCol = 0;
    // Phase 1: match containers
    idx = 1; allMatched = true;
    let bqMatched = false;
    while (idx < open.length) {
      const b = open[idx];
      if (b.t === 'list') { idx++; continue; } // a list consumes no input
      if (b.t === 'blockquote') {
        const saveP = pos, saveC = col;
        const w = wsEnd(3);
        if (w && s[w.p] === '>') {
          pos = w.p + 1; col = w.c + 1;
          bqMatched = true;
          if (s[pos] === ' ') { pos++; col++; }
          else if (s[pos] === '\t') {
            // consume 1 column of the tab; keep the rest as spaces.
            // The tab expands from the column relative to the
            // innermost enclosing container's content start (saveC),
            // not the absolute column: inside a list item the tab
            // after `>` is narrower than the absolute column says.
            const tw = 4 - ((col - saveC) % 4);
            s = s.slice(0, pos) + ' '.repeat(tw - 1) + s.slice(pos + 1);
            col++;
          }
          idx++;
        } else { pos = saveP; col = saveC; allMatched = false; break; }
      } else if (b.t === 'item') {
        if (isBlankFrom(pos)) { idx++; continue; }
        const ind = countIndent();
        if (ind < b.indent) { allMatched = false; break; }
        advanceTo(col + b.indent);
        itemContentCol = col;
        idx++;
      } else break;
    }
    // A line is blank when nothing but whitespace remains — except that
    // after a blockquote marker (and its one space) any remainder, even
    // just spaces, is content.
    const blank = isBlankFrom(pos) && !(bqMatched && pos < s.length);
    const tip = () => open[open.length - 1];

    if (blank) {
      const t = tip();
      if (allMatched && t.t === 'fence') { stripFenceIndent(t.indent); t.lines.push(rest()); }
      else if (allMatched && t.t === 'code') {
        // a blank line inside indented code keeps its indent minus 4 cols
        advanceTo(col + 4);
        t.lines.push(rest());
      }
      else if (allMatched && t.t === 'html' && (t.htmlType === 1 || t.htmlType === 2 || t.htmlType === 3 || t.htmlType === 4 || t.htmlType === 5) && !t.ended) { t.lines.push(''); t.lastLine = li; }
      else if (allMatched && t.t === 'table' && rest().includes('\t')) {
        // a whitespace-only line containing a tab inside a table is an
        // empty row; a spaces-only (or truly empty) line ends the table
        t.rows.push(splitRow(rest()));
      }
      else {
        if (!allMatched) {
          for (let k = idx; k < open.length; k++) if (open[k].t === 'html') open[k].blankEnded = true;
          closeTo(idx);
        }
        else if (t.t === 'para' || t.t === 'table' || (t.t === 'html' && (t.htmlType === 6 || t.htmlType === 7 || t.ended))) {
          if (t.t === 'html') t.blankEnded = true;
          closeTo(open.length - 1);
        }
        else if (t.t === 'item' && t.children.length === 0) {
          // a blank line closes an empty list item
          closeTo(open.length - 1);
        }
        // a blank line marks list looseness when it occurs inside a list
        // item (at any depth): the next block added to an item/list that
        // already has children makes that list loose. Walk up from the
        // tip: a blank line that merely closes a blockquote deep inside
        // an item still separates that item's blocks (doc-19: a blank
        // before a blockquote that is a direct child of the item, after
        // a nested list). But a blank line that itself carries a
        // blockquote marker (bqMatched, cm-320) is a blank inside the
        // blockquote, not a separator: keep the narrow check there.
        if (bqMatched) {
          const tp = t.parent;
          if (tp && (tp.t === 'item' || tp.t === 'list' || tp.t === 'doc')) sawBlank = true;
          else if (t.t === 'item' || t.t === 'list' || t.t === 'doc') sawBlank = true;
        } else {
          let anc = t;
          while (anc) {
            if (anc.t === 'item' || anc.t === 'list' || anc.t === 'doc') { sawBlank = true; break; }
            anc = anc.parent;
          }
        }
      }
      continue;
    }

    // Non-blank line: process until consumed
    let guard = 0;
    while (guard++ < 8) {
      const t = tip();
      if (t.t === 'fence') {
        // A missing blockquote marker always closes the fence
        // (cm-237: `> ```\n> foo\nbar` ends the blockquote and the
        // fence, `bar` is a paragraph). A missing list-item indent
        // closes it only before it has any content: an unindented
        // first line leaves the fence empty, but once the fence has
        // a content line, later unindented lines are still content.
        if (!allMatched) {
          if ((open[idx] && open[idx].t === 'blockquote') || t.lines.length === 0) {
            closeTo(idx); allMatched = true; continue;
          }
          // a line that starts a block closes the fence (and the
          // unmatched containers); it is reprocessed as a new block
          if (fenceStartsBlock()) { closeTo(idx); allMatched = true; continue; }
        }
        if (closeFence(t)) {
          // the blank line immediately before the closing fence is not
          // part of the content
          if (t.lines.length > 0 && t.lines[t.lines.length - 1] === '') t.lines.pop();
          closeTo(open.length - 1);
        }
        else {
          stripFenceIndent(t.indent);
          // a tab at the start of the content, inside a container, is
          // expanded to spaces (a top-level tab is kept). Inside a
          // blockquote with no fence indent it always becomes 2 spaces;
          // otherwise it fills to the next tab stop for its column.
          // pos stays at the inserted spaces so rest() includes them.
          if (col > 0 && t.parent && t.parent.t !== 'doc' && s[pos] === '\t') {
            let w;
            if (t.indent === 0 && t.parent.t === 'blockquote') w = 2;
            else w = 4 - (col % 4);
            s = s.slice(0, pos) + ' '.repeat(w) + s.slice(pos + 1);
            col += w;
          }
          t.lines.push(rest());
        }
        break;
      }
      if (t.t === 'code') {
        if (!allMatched) { closeTo(idx); allMatched = true; continue; }
        const ind = countIndent();
        if (ind >= 4) { advanceTo(col + 4); t.lines.push(rest()); break; }
        closeTo(open.length - 1);
        continue;
      }
      if (t.t === 'html') {
        if (!allMatched) { closeTo(idx); allMatched = true; continue; }
        if (!t.ended) {
          const line = rest();
          t.lines.push(line);
          t.trailingNL = (li < lines.length - 1) || srcEndsWithNL;
          t.lastLine = li;
          if (htmlEnded(t, line)) { t.ended = true; closeTo(open.length - 1); }
          break;
        }
        closeTo(open.length - 1);
        continue;
      }
      if (t.t === 'table') {
        if (!allMatched) { closeTo(idx); allMatched = true; continue; }
        // a line that starts a block which can interrupt a table ends it
        if (tryBlockquote() || tryAtx() || tryFence() || tryHr() || tryList() || tryHtml()) {
          closeTo(open.length - 1); continue;
        }
        // any other non-blank line continues the table as a row, even without pipes
        t.rows.push(splitRow(rest())); break;
      }
      // Lazy continuation: some containers did not match, but the tip is a
      // paragraph. The line continues it unless it is a setext underline
      // or starts a block that can interrupt a paragraph.
      if (!allMatched && t.t === 'para') {
        const lvl = setextLevel();
        if (lvl === 1) {
          // a lazy === line is paragraph text; inside a blockquote it is
          // indented to at least 4 columns so it cannot be a setext line
          const line = lazyLine();
          if (open[idx] && open[idx].t === 'blockquote') {
            const m = /^[ ]*/.exec(line);
            const ind = m ? m[0].length : 0;
            t.lines.push(' '.repeat(Math.max(0, 4 - ind)) + line);
          } else {
            t.lines.push(line);
          }
          break;
        }
        if (lvl === 2) {
          // --- is a thematic break: close the containers, re-process
          closeTo(idx); allMatched = true;
          continue;
        }
        // a list marker at the outer level (the paragraph is inside a
        // list item whose container did not match) is not a lazy
        // continuation: it closes the item and starts a new item or list
        const li0 = tryList();
        if (li0) {
          let enc = null;
          for (let k = open.length - 2; k >= 1; k--) {
            if (open[k].t === 'item') { enc = open[k].list; break; }
            if (open[k].t !== 'blockquote') break;
          }
          if (enc) {
            closeTo(idx); allMatched = true;
            continue;
          }
        }
        if (lazyContinuation()) {
          t.lines.push(lazyLine());
          break;
        }
        closeTo(idx); allMatched = true;
        continue;
      }
      if (!allMatched) { closeTo(idx); allMatched = true; }
      // Setext heading (extract refs from the paragraph first)
      if (t.t === 'para') {
        const lvl = setextLevel();
        if (lvl) {
          finalizePara(t);
          if (!t.empty) {
            const para = open.pop();
            // setext heading content is the paragraph text, trimmed
            const heading = { t: 'heading', level: lvl, text: para.text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, ''), children: [], parent: para.parent };
            const parent = open[open.length - 1];
            const pi = parent.children.indexOf(para);
            if (pi >= 0) parent.children[pi] = heading;
            break;
          } else {
            // definitions only: drop the paragraph, re-process this line
            const para = open.pop();
            const parent = open[open.length - 1];
            const pi = parent.children.indexOf(para);
            if (pi >= 0) parent.children.splice(pi, 1);
            continue;
          }
        }
      }
      // Table delimiter row
      if (t.t === 'para') {
        finalizePara(t);
        if (!t.empty) {
          const tab = tryTableDelim(t);
          if (tab) {
            const para = open.pop();
            const parent = open[open.length - 1];
            const pi = parent.children.indexOf(para);
            const table = { t: 'table', align: tab.align, header: tab.headerCells, rows: [], children: [], parent };
            if (pi >= 0) parent.children[pi] = table;
            else parent.children.push(table);
            // earlier paragraph lines (before the header line) stay as a paragraph
            if (tab.headerLines.length > 1) {
              const pre = { t: 'para', lines: tab.headerLines.slice(0, -1), children: [], parent };
              finalizePara(pre);
              if (!pre.empty) {
                const insAt = pi >= 0 ? pi : parent.children.length;
                parent.children.splice(insAt, 0, pre);
              }
            }
            open.push(table);
            break;
          }
        }
        // when the paragraph is definitions-only, the line is a paragraph
        // continuation (it may be a title of the definition): fall through
      }
      // New block starts
      const paraOpen = tip().t === 'para';
      const f = tryFence();
      if (f) {
        if (!allMatched) { closeTo(idx); allMatched = true; }
        else if (paraOpen) closeTo(open.length - 1);
        pos = f.p; col = f.c;
        // Tilde fences never strip their indent from content lines
        // (marked quirk): `   ~~~js` keeps `   const x = 1;`
        // verbatim, and `>   ~~~` keeps the content's spaces after
        // `> `. Backtick fences do strip their indent.
        const findent = f.ch === '~' ? 0 : f.indent;
        const node = { t: 'fence', fence: f.ch, len: f.len, info: f.info, indent: findent, lines: [], children: [], parent: open[open.length - 1] };
        pushOpen(node);
        break;
      }
      const atx = tryAtx();
      if (atx) {
        if (!allMatched) { closeTo(idx); allMatched = true; }
        else if (paraOpen) closeTo(open.length - 1);
        const node = { t: 'heading', level: atx.level, text: atx.content, children: [], parent: open[open.length - 1] };
        addChild(node);
        break;
      }
      if (tryHr()) {
        if (!allMatched) { closeTo(idx); allMatched = true; }
        else if (paraOpen) closeTo(open.length - 1);
        const node = { t: 'hr', children: [], parent: open[open.length - 1] };
        addChild(node);
        break;
      }
      const bq = tryBlockquote();
      if (bq) {
        if (!allMatched) { closeTo(idx); allMatched = true; }
        else if (paraOpen) closeTo(open.length - 1);
        // apply the tab-partial rewrite if the char after > was a tab
        pos = bq.p; col = bq.c;
        if (bq.tabPartial) {
          // the tab sits at bq.p; keep bq.tabKeep spaces (computed
          // from the container-relative column in tryBlockquote)
          s = s.slice(0, bq.p) + ' '.repeat(bq.tabKeep) + s.slice(bq.p + 1);
        }
        const node = { t: 'blockquote', children: [], parent: open[open.length - 1] };
        pushOpen(node);
        continue; // re-check for more blocks on this line
      }
      const li2 = tryList();
      if (li2) {
        // an empty list item cannot interrupt a paragraph; an ordered
        // list needs start 1 unless the paragraph sits inside a list item
        // (then any start opens a nested list)
        const canInterrupt = !paraOpen || (!li2.empty && (!li2.ordered || li2.start === 1 || inListItem()));
        if (canInterrupt) {
          if (!allMatched) { closeTo(idx); allMatched = true; }
          else if (paraOpen) closeTo(open.length - 1);
          let parent = open[open.length - 1];
          let list = null;
          if (parent.t === 'list' && parent.ordered === li2.ordered && parent.delim === li2.delim && parent.bullet === li2.bullet) {
            list = parent; // add the item to the open list
          } else {
            if (parent.t === 'list') { closeTo(open.length - 1); parent = open[open.length - 1]; }
            const last = parent.children[parent.children.length - 1];
            if (last && last.t === 'list' &&
                last.ordered === li2.ordered && last.delim === li2.delim && last.bullet === li2.bullet) {
              list = last;
            }
            if (!list) {
              list = { t: 'list', ordered: li2.ordered, start: li2.start, delim: li2.delim, bullet: li2.bullet, loose: false, children: [], parent };
              addChild(list);
            }
          }
          const item = { t: 'item', indent: li2.contentIndent - col, list, children: [], parent: list };
          if (sawBlank && list.children.length > 0) list.loose = true;
          list.children.push(item);
          open.push(item);
          if (li2.empty) break;
          pos = li2.after; col = li2.afterCol;
          advanceTo(li2.contentIndent);
          continue; // parse the item's content on this line
        }
      }
      const html = tryHtml();
      if (html) {
        const canInterrupt = !paraOpen || html.type !== 7;
        if (canInterrupt) {
          if (!allMatched) { closeTo(idx); allMatched = true; }
          else if (paraOpen) closeTo(open.length - 1);
          const node = { t: 'html', htmlType: html.type, htmlEnd: html.end, ended: false, lines: [rest()], trailingNL: (li < lines.length - 1) || srcEndsWithNL, lastLine: li, children: [], parent: open[open.length - 1] };
          if (html.type !== 6 && html.type !== 7 && htmlEnded(node, node.lines[0])) node.ended = true;
          pushOpen(node);
          break;
        }
      }
      // Indented code (cannot interrupt a paragraph)
      if (!paraOpen) {
        const ind = localIndent();
        if (ind >= 4) {
          if (!allMatched) { closeTo(idx); allMatched = true; }
          advanceTo(col + 4);
          const node = { t: 'code', lines: [rest()], children: [], parent: open[open.length - 1] };
          pushOpen(node);
          break;
        }
      }
      // Paragraph continuation or new paragraph
      if (paraOpen) {
        // inside a list item, a continuation indented by 4+ (past the item
        // indent) loses those 4 columns, as indented code would; the
        // indent is measured from the item's content start, so a tab
        // after `>` inside an item counts less than 4 columns
        if (inListItem() && localIndent() >= 4) advanceTo(col + 4);
        tip().lines.push(expandLeadTabs(rest(), col - itemContentCol));
        break;
      }
      if (!allMatched) { closeTo(idx); allMatched = true; }
      const node = { t: 'para', lines: [expandLeadTabs(rest(), col - itemContentCol)], children: [], parent: open[open.length - 1] };
      pushOpen(node);
      break;
    }
    if (!blank) sawBlank = false;
  }
  // blocks still open here end at EOF
  for (const b of open) b.atEOF = true;
  closeTo(1);
  // drop empty paragraphs left over (definitions only)
  // (finalize already splices them out of their parents)
  return { root, refs };
}

// ---- inline parsing ----------------------------------------------------
// Node kinds:
//  t: text (raw; backslash escapes resolved, entities raw)
//  code: code span content (raw)
//  html: raw inline HTML
//  br: hard break, soft: soft break
//  em/strong/del: containers with c: children
//  link: {href, title, c}; img: {src, title, c}
//  delim: emphasis delimiter (temporary; renders literally when unmatched)
//  bracket: link opener (temporary; renders literally when unmatched)
//  auto: autolink {href, text}

function flanking(src, i, j) {
  // delimiter run src[i..j); returns {left, right} flanking flags.
  // The char before the run is src[i-1] (or start), after is src[j] (or end).
  const before = i > 0 ? src[i - 1] : '';
  const after = j < src.length ? src[j] : '';
  const beforeWs = before === '' || isUniSpace(before.codePointAt(0));
  const afterWs = after === '' || isUniSpace(after.codePointAt(0));
  const beforePunct = before !== '' && isPunct(before);
  const afterPunct = after !== '' && isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right };
}

function tryAutolink(src, i) {
  // src[i] === '<'. Returns {href, text, end} or null.
  const n = src.length;
  let j = i + 1;
  // scheme: 2..32 chars, letter then [A-Za-z0-9+.-]*
  if (j < n && isAlphaCode(src.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && isSchemeCode(src.charCodeAt(k))) k++;
    const schemeLen = k - j;
    if (schemeLen >= 2 && schemeLen <= 32 && src[k] === ':') {
      let e = k + 1;
      while (e < n && src[e] !== ' ' && src[e] !== '\t' && src[e] !== '\n' && src[e] !== '<' && src[e] !== '>') e++;
      if (e > k + 1 && src[e] === '>') {
        const uri = src.slice(i + 1, e);
        return { href: uri, text: uri, end: e + 1 };
      }
    }
  }
  // email: local@domain
  let k = j;
  while (k < n && isEmailCode(src.charCodeAt(k))) k++;
  if (k > j && src[k] === '@') {
    let d = k + 1;
    // domain: labels separated by dots
    let ok = false;
    while (d < n) {
      const ls = d;
      while (d < n && isDomainCode(src.charCodeAt(d))) d++;
      if (d === ls) break;
      if (src[d] === '.') { d++; continue; }
      if (src[d] === '>') { ok = true; break; }
      break;
    }
    if (ok && d > k + 1) {
      const email = src.slice(i + 1, d);
      // the domain (after @) must contain a dot, not at its start or end
      const dom = email.slice(email.indexOf('@') + 1);
      if (dom.indexOf('.') > 0 && !dom.endsWith('.')) {
        return { href: 'mailto:' + email, text: email, end: d + 1 };
      }
    }
  }
  return null;
}

function tryHtmlInline(src, i) {
  // src[i] === '<'. Returns the raw HTML string or null.
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    // abruptly-closed empty comments
    if (src.startsWith('<!-->', i)) return '<!-->';
    if (src.startsWith('<!--->', i)) return '<!--->';
    const e = src.indexOf('-->', i + 4);
    if (e < 0) return null;
    const inner = src.slice(i + 4, e);
    // a comment may not end with -
    if (inner.endsWith('-')) return null;
    return src.slice(i, e + 3);
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    if (e < 0) return null;
    return src.slice(i, e + 2);
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return src.slice(i, e + 3);
  }
  if (src.startsWith('<!', i) && i + 2 < n && isAlphaCode(src.charCodeAt(i + 2))) {
    const e = src.indexOf('>', i + 2);
    if (e < 0) return null;
    return src.slice(i, e + 1);
  }
  // tag: <name (ws attr)* ws? /? >
  let j = i + 1, closing = false;
  if (src[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlphaCode(src.charCodeAt(j))) return null;
  while (j < n && isDomainCode(src.charCodeAt(j))) j++;
  if (closing) {
    // a closing tag allows only whitespace before >
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    if (j < n && src[j] === '>') return src.slice(i, j + 1);
    return null;
  }
  // attributes: ws* name (ws* = ws* value)? — names and values validated
  while (j < n) {
    // skip whitespace (including newlines) between attributes
    let k = j;
    while (k < n && isSpace(src.charCodeAt(k))) k++;
    if (k >= n) return null;
    if (src[k] === '>') return src.slice(i, k + 1);
    if (src[k] === '/' && k + 1 < n && src[k + 1] === '>') return src.slice(i, k + 2);
    if (k !== j && !isNameStartCode(src.charCodeAt(k))) return null;
    if (k === j) return null; // an attribute must follow whitespace (or > or />)
    j = k;
    // attribute name
    if (!isNameStartCode(src.charCodeAt(j))) return null;
    j++;
    while (j < n && isNameCode(src.charCodeAt(j))) j++;
    // optional = value
    k = j;
    while (k < n && isSpace(src.charCodeAt(k))) k++;
    if (k < n && src[k] === '=') {
      k++;
      while (k < n && isSpace(src.charCodeAt(k))) k++;
      if (k >= n) return null;
      if (src[k] === '"' || src[k] === "'") {
        const q = src[k]; k++;
        const e = src.indexOf(q, k);
        if (e < 0) return null;
        j = e + 1;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        if (!isUnquotedValCode(src.charCodeAt(k))) return null;
        j = k;
        while (j < n && isUnquotedValCode(src.charCodeAt(j))) j++;
      }
    } else {
      // no value: leave j after the attribute name so the loop's own
      // whitespace skip handles the gap before the next attribute
    }
  }
  return null;
}

// Parse an inline link's (dest "title") starting at src[i] === '('.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && isSpace(src.charCodeAt(j))) j++;
  if (j >= n) return null;
  let dest = '';
  if (src[j] === '<') {
    j++;
    while (j < n && src[j] !== '>' && src[j] !== '\n' && src[j] !== '<') {
      if (src[j] === '\\' && j + 1 < n && isAsciiPunctChar(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
      dest += src[j]; j++;
    }
    if (j >= n || src[j] !== '>') return null;
    j++;
  } else {
    let depth = 0;
    while (j < n) {
      const ch = src[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) break;
      if (ch === '\\' && j + 1 < n && isAsciiPunctChar(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
      if (ch === '(') { depth++; dest += ch; j++; continue; }
      if (ch === ')') { if (depth === 0) break; depth--; dest += ch; j++; continue; }
      dest += ch; j++;
    }
    if (depth !== 0) return null;
  }
  let k = j;
  while (k < n && isSpace(src.charCodeAt(k))) k++;
  let title = null;
  if (k < n && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
    const t = parseTitle(src, k);
    if (!t) return null;
    title = t.title; k = t.end;
    while (k < n && isSpace(src.charCodeAt(k))) k++;
  }
  if (k >= n || src[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

// Parse a reference label starting at src[i] === '[' (raw, escapes kept).
// A label may not contain an unescaped '[' (escaped \[ is fine).
function parseRefLabel(src, i) {
  const n = src.length;
  let j = i + 1, depth = 0, label = '';
  while (j < n) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunctChar(src[j + 1])) { label += src[j]; label += src[j + 1]; j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      if (depth === 0) return { label, end: j + 1 };
      depth--; label += ch; j++; continue;
    }
    label += ch; j++;
  }
  return null;
}

// GFM extended autolinks: www. / http(s):// / email, with trailing
// punctuation trimmed and parens balanced.
function tryExtendedAutolink(src, i, stopAtBracket) {
  // No autolink inside an unclosed inline <a> tag.
  if (inAnchor) return null;
  const n = src.length;
  // preceding char must be start, whitespace, or one of * _ ~ ( <
  if (i > 0) {
    const prev = src[i - 1];
    if (!(isUniSpace(prev.codePointAt(0)) || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<')) return null;
  }
  let end = -1, href = null, isScheme = false;
  // scheme autolink: scheme:email[/resource] (mailto:, xmpp:, ...)
  {
    let m = i + 1;
    if (m < n && isAlphaCode(src.charCodeAt(i))) {
      while (m < n && isSchemeCode(src.charCodeAt(m))) m++;
      const schemeLen = m - i;
      if (schemeLen >= 2 && schemeLen <= 32 && m < n && src[m] === ':') {
        const after = m + 1;
        // the part after the scheme is an email, optionally followed by
        // a single /resource segment
        let k = after;
        while (k < n && isEmailCode(src.charCodeAt(k))) k++;
        if (k > after && src[k] === '@') {
          const d = scanDomain(src, k + 1);
          if (d >= 0) {
            const dom = src.slice(k + 1, d);
            if (dom.indexOf('.') >= 1 && src[d - 1] !== '-' &&
                !(d < n && (src[d] === '_' || isAlnumCode(src.charCodeAt(d))))) {
              let e = d;
              // one optional /segment (a bare / is not included)
              if (e < n && src[e] === '/' && e + 1 < n && src[e + 1] !== ' ' && src[e + 1] !== '\t' && src[e + 1] !== '\n' && src[e + 1] !== '<') {
                e++;
                while (e < n && src[e] !== ' ' && src[e] !== '\t' && src[e] !== '\n' && src[e] !== '<' && src[e] !== '/') e++;
              }
              end = e;
              href = src.slice(i, end);
              isScheme = true;
            }
          }
        }
      }
    }
  }
  if (!isScheme) {
    if (src.startsWith('www.', i)) {
    end = scanDomain(src, i + 4);
    if (end < 0) return null;
    href = 'http://' + src.slice(i, end);
  } else if (isHttpStart(src, i)) {
    const schemeLen = (src[i + 4] === 's' || src[i + 4] === 'S') ? 8 : 7;
    end = scanDomain(src, i + schemeLen);
    if (end < 0) return null;
    href = src.slice(i, end);
  } else {
    // email: local@domain
    let k = i;
    while (k < n && isEmailCode(src.charCodeAt(k))) k++;
    if (k > i && src[k] === '@') {
      const d = scanDomain(src, k + 1);
      if (d < 0) return null;
      // domain must contain a dot
      const dom = src.slice(k + 1, d);
      if (dom.indexOf('.') < 1) return null;
      // a domain ending in - or followed by a word char is not an autolink
      // (a following _ is handled by the caller: it is fine when it closes
      // an emphasis run, but not when it is part of the word)
      if (src[d - 1] === '-') return null;
      if (d < n && isAlnumCode(src.charCodeAt(d))) return null;
      end = d;
      href = 'mailto:' + src.slice(i, end);
    } else return null;
  }
  }
  if (end < 0) return null;
  // include a path/query part for www/http links: continue while not
  // whitespace or '<'. A ] is only a stop when the autolink sits inside
  // a live link label (stopAtBracket) and the ] is followed by ( or [,
  // so the label's link can still form; otherwise the ] (and what
  // follows it) belongs to the URL (doc-08/12/22/37).
  if (!href.startsWith('mailto:') && !isScheme) {
    let e = end;
    while (e < n && src[e] !== ' ' && src[e] !== '\t' && src[e] !== '\n' && src[e] !== '<') {
      if (src[e] === ']' && stopAtBracket && (src[e + 1] === '(' || src[e + 1] === '[')) break;
      e++;
    }
    end = e;
  }
  // if the link ends with ';' and the tail looks like an entity, drop it
  // (checked before trailing-punctuation trimming, which would eat the ;)
  if (end > i && src[end - 1] === ';') {
    let p = end - 2;
    while (p >= i && (isAlnumCode(src.charCodeAt(p)) || src[p] === '#')) p--;
    if (p >= i && src[p] === '&') end = p;
  }
  // trim trailing punctuation (? ! . , : ; * _ ~) and unbalanced ')'s,
  // alternating until stable: dropping a ')' can expose a '.', and
  // dropping a '.' can expose an unbalanced ')'. The ')' rule is
  // GFM's: if the run of trailing ')'s is longer than the number of
  // '('s in the URL, drop the excess. And if the text after the last
  // '(' has no ')', the paren is unclosed: drop from that '(' onward
  // (doc-08: ...example.io)](https://npmjs.com/heading -> ...example.io)]).
  let e2 = end;
  let changed = true;
  while (changed) {
    changed = false;
    while (e2 > i) {
      const ch = src[e2 - 1];
      if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '*' || ch === '_' || ch === '~') { e2--; changed = true; }
      else break;
    }
    let r = 0;
    while (r < e2 - i && src[e2 - 1 - r] === ')') r++;
    if (r > 0) {
      let o = 0;
      for (let p = i; p < e2; p++) if (src[p] === '(') o++;
      if (r > o) { e2 -= (r - o); changed = true; }
    }
    let lastOpen = -1;
    for (let p = i; p < e2; p++) if (src[p] === '(') lastOpen = p;
    if (lastOpen >= 0) {
      let hasClose = false;
      for (let p = lastOpen + 1; p < e2; p++) if (src[p] === ')') { hasClose = true; break; }
      if (!hasClose) { e2 = lastOpen; changed = true; }
    }
  }
  if (e2 <= i) return null;
  const text = src.slice(i, e2);
  const h = isScheme ? text
    : href.startsWith('mailto:') ? 'mailto:' + text
    : src.startsWith('www.', i) ? 'http://' + text : text;
  return { href: h, text, end: e2 };
}

// Scan a domain starting at src[i]: labels of [A-Za-z0-9-]+ separated by
// dots. Returns the end index (just past the last label; a trailing dot is
// excluded), or -1 when there are fewer than two labels.
function scanDomain(src, i) {
  const n = src.length;
  let j = i, labels = 0, end = i;
  while (j < n) {
    const ls = j;
    while (j < n && isDomainCode(src.charCodeAt(j))) j++;
    if (j === ls) break;
    labels++;
    end = j;
    if (src[j] === '.') { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  return end;
}

// Whether inline parsing is currently inside an unclosed <a> tag.
// An unclosed inline <a> suppresses autolinks (but not explicit links)
// for the rest of the document; a closing </a> re-enables them.
// Whether a link label is blocked from forming a link by an unclosed
// code span. Scanned with marked's lenient code-span rule: a backtick
// run opens a code span, the next backtick run closes it. If the label
// ends inside an unclosed code span, the link is blocked -- unless the
// opening run is a multi-backtick run (length >= 2) that ends exactly
// at the label end (the run sits right before the ]), in which case
// the ] still closes the label. This fits all of doc-03/doc-09/doc-16/
// doc-18/doc-20/doc-23/doc-28/doc-30/doc-33/doc-35 and cm-342/cm-525:
// a final 2-run right before the ] forms the link, a lone 1-run (even
// right before the ]) or any run with text after it does not.
function isLabelBlocked(src, start, end) {
  let i = start, inCode = false, codeOpenEnd = -1, codeOpenLen = 0;
  while (i < end) {
    const c = src[i];
    if (c === '\\' && i + 1 < end && isAsciiPunctChar(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < end && src[j] === '`') j++;
      if (inCode) inCode = false;
      else { inCode = true; codeOpenEnd = j; codeOpenLen = j - i; }
      i = j; continue;
    }
    i++;
  }
  if (!inCode) return false;
  if (codeOpenLen >= 2 && codeOpenEnd === end) return false;
  return true;
}

// Does the label src[start,end] end with a code span still open? Scan
// backtick runs: a run opens a span if none is open; it closes the open
// span iff its length equals the open span's length; otherwise it is span
// content. Escaped backticks are skipped. (A formed link whose label
// ends with an unclosed code span suppresses emphasis up to the last
// backtick run of the paragraph — rule (A).)
function labelHasUnclosedSpan(src, start, end) {
  let openLen = 0, i = start;
  while (i < end) {
    const c = src[i];
    if (c === '\\' && i + 1 < end && isAsciiPunctChar(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i, run = 0;
      while (j < end && src[j] === '`') { j++; run++; }
      if (openLen === 0) openLen = run;
      else if (run === openLen) openLen = 0;
      i = j; continue;
    }
    i++;
  }
  return openLen > 0;
}

let inAnchor = false;

function scanInline(src, refs) {
  const nodes = [];
  const brackets = [];
  const linkLists = []; // node lists needing emphasis processing
  const n = src.length;
  // start index of the last backtick run in this paragraph (escaped
  // backticks skipped); -1 when there is none. Together with minL1End
  // it defines the emphasis-suppression zone of rule (A).
  let lastBt = -1;
  for (let q = 0; q < n;) {
    if (src[q] === '\\' && q + 1 < n && isAsciiPunctChar(src[q + 1])) { q += 2; continue; }
    if (src[q] === '`') { lastBt = q; while (q < n && src[q] === '`') q++; continue; }
    q++;
  }
  let minL1End = Infinity; // end of the earliest formed link whose label ends with an unclosed code span
  let i = 0, t0 = 0;
  const flushText = (end) => {
    if (end > t0) {
      const s = src.slice(t0, end);
      const last = nodes[nodes.length - 1];
      if (last && last.k === 't') last.s += s; else nodes.push({ k: 't', s });
    }
  };
  const pushTextStr = (s) => {
    const last = nodes[nodes.length - 1];
    if (last && last.k === 't') last.s += s; else nodes.push({ k: 't', s });
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 < n) {
        const nx = src[i + 1];
        if (nx === '\n') {
          flushText(i); nodes.push({ k: 'br' }); i += 2;
          // leading whitespace after a hard break is stripped
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          t0 = i; continue;
        }
        if (isAsciiPunctChar(nx)) {
          flushText(i);
          // an escaped & must not start an entity: keep it separate so the
          // following text cannot merge into an entity reference
          if (nx === '&') nodes.push({ k: 'amp' });
          else pushTextStr(nx);
          i += 2; t0 = i; continue;
        }
      }
      i++; continue;
    }
    if (ch === '\n') {
      flushText(i);
      const last = nodes[nodes.length - 1];
      if (last && last.k === 't') {
        let sp = 0;
        while (sp < last.s.length && last.s[last.s.length - 1 - sp] === ' ') sp++;
        if (sp >= 2) {
          last.s = last.s.slice(0, last.s.length - sp);
          nodes.push({ k: 'br' });
          i++;
          // leading whitespace after a hard break is stripped
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          t0 = i; continue;
        }
        else nodes.push({ k: 'soft' });
      } else nodes.push({ k: 'soft' });
      i++; t0 = i; continue;
    }
    if (ch === '`') {
      let j = i, run = 0;
      while (src[j] === '`') { j++; run++; }
      const tick = '`'.repeat(run);
      // If this run sits inside a bracket whose closing ] forms a link,
      // the code-span closer must not cross that ] (marked's label rule
      // cannot match a code span that runs past the label end). Find the
      // closing ] of the innermost open bracket, tracking nested [ depth.
      let limit = -1;
      if (brackets.length) {
        const br = brackets[brackets.length - 1];
        let depth = 0, k = j;
        while (k < n) {
          const c = src[k];
          if (c === '\\' && k + 1 < n && isAsciiPunctChar(src[k + 1])) { k += 2; continue; }
          if (c === '[') depth++;
          else if (c === ']') {
            if (depth === 0) {
              // the ] forms a link only if the label is not blocked by a
              // backtick-content code span and a destination/reference
              // resolves (cm-342: the label has a lone backtick, so the
              // ] does NOT form a link and the code span may cross it)
              let forms = !isLabelBlocked(src, br.pos + (br.img ? 2 : 1), k);
              if (forms) {
                if (src[k + 1] === '(') forms = !!parseInlineLink(src, k + 1);
                else if (src[k + 1] === '[') {
                  const lab = parseRefLabel(src, k + 1);
                  if (lab) {
                    if (lab.label === '') forms = refs.has(normalizeLabel(src.slice(br.pos + (br.img ? 2 : 1), k)));
                    else forms = refs.has(normalizeLabel(lab.label));
                  } else forms = false;
                } else {
                  const norm = normalizeLabel(src.slice(br.pos + (br.img ? 2 : 1), k));
                  forms = norm !== '' && refs.has(norm);
                }
              }
              if (forms) limit = k;
              break;
            }
            depth--;
          }
          k++;
        }
      }
      let p = src.indexOf(tick, j), found = -1;
      while (p >= 0 && (limit < 0 || p < limit)) {
        let q = p, rlen = 0;
        while (src[q] === '`') { q++; rlen++; }
        if (rlen === run) { found = p; break; }
        p = src.indexOf(tick, q);
      }
      if (found >= 0) {
        flushText(i);
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ') {
          let allSpace = true;
          for (let c = 0; c < content.length; c++) if (content[c] !== ' ') { allSpace = false; break; }
          if (!allSpace) content = content.slice(1, -1);
        }
        nodes.push({ k: 'code', s: content });
        i = found + run; t0 = i; continue;
      }
      i = j; continue;
    }
    if (ch === '<') {
      const auto = tryAutolink(src, i);
      if (auto) { flushText(i); nodes.push({ k: 'auto', angle: true, href: auto.href, text: auto.text }); i = auto.end; t0 = i; continue; }
      const html = tryHtmlInline(src, i);
      if (html) {
        flushText(i);
        // track an open inline <a> tag: autolinks are suppressed inside it
        const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(html);
        if (m && m[1].toLowerCase() === 'a') {
          if (html[1] === '/') inAnchor = false;
          // a self-closing <a> only counts when the `/` sits directly
          // before `>` with no whitespace: `<a/>` is self-closing,
          // but `<a />` (space before `/>`) is an opening tag and
          // suppresses later autolinks.
          else if (!/[^\s]\/>$/.test(html)) inAnchor = true;
        }
        nodes.push({ k: 'html', s: html }); i += html.length; t0 = i; continue;
      }
      i++; continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const img = ch === '!';
      flushText(i);
      const node = { k: 'bracket', img, active: true, pos: i };
      nodes.push(node);
      brackets.push(node);
      i += img ? 2 : 1; t0 = i; continue;
    }
    if (ch === ']') {
      flushText(i);
      const br = brackets.length ? brackets[brackets.length - 1] : null;
      let formed = false;
      if (br) {
        let dest = null, title = null, endPos = -1;
        if (src[i + 1] === '(') {
          const il = parseInlineLink(src, i + 1);
          if (il) { dest = il.dest; title = il.title; endPos = il.end; }
        }
        if (dest === null && src[i + 1] === '[') {
          const lab = parseRefLabel(src, i + 1);
          if (lab) {
            const ref = refs.get(normalizeLabel(lab.label));
            if (ref) { dest = ref.dest; title = ref.title; endPos = lab.end; }
          }
          if (dest === null && lab && lab.label === '') {
            // collapsed reference: label is the link text
            const rawText = src.slice(br.pos + (br.img ? 2 : 1), i);
            const ref = refs.get(normalizeLabel(rawText));
            if (ref) { dest = ref.dest; title = ref.title; endPos = lab.end; }
          }
        }
        if (dest === null && src[i + 1] !== '[') {
          // shortcut reference: label is the link text. A [ after the ]
          // means a full reference was intended; if that failed, there is
          // no shortcut fallback. (A ( after the ] that fails to parse as
          // an inline link does fall back to a shortcut.)
          const rawText = src.slice(br.pos + (br.img ? 2 : 1), i);
          const norm = normalizeLabel(rawText);
          if (norm !== '') {
            const ref = refs.get(norm);
            if (ref) { dest = ref.dest; title = ref.title; endPos = i + 1; }
          }
        }
        // A label blocked by a code span whose content holds a backtick
        // (and which is not at the label end) does not form a link.
        if (dest !== null && isLabelBlocked(src, br.pos + (br.img ? 2 : 1), i)) dest = null;
        if (dest !== null) {
          const bi = nodes.indexOf(br);
          const children = nodes.slice(bi + 1);
          // a link cannot contain another link: if the link text already
          // holds a link node, this [ does not form a link
          if (!br.img) {
            let hasLink = false;
            const scan = (list) => {
              for (const nd of list) {
                if (nd.k === 'link') { hasLink = true; return; }
                if (nd.c) scan(nd.c);
                if (hasLink) return;
              }
            };
            scan(children);
            if (hasLink) {
              if (br) {
                const bix = brackets.indexOf(br);
                if (bix >= 0) brackets.splice(bix, 1);
              }
              t0 = i; i++; continue;
            }
            // an extended autolink inside link text is demoted to plain
            // text (an angle-bracket autolink stays a nested link)
            const demote = (list) => {
              for (let q = 0; q < list.length; q++) {
                const nd = list[q];
                if (nd.k === 'auto' && !nd.angle) list[q] = { k: 't', s: nd.text };
                else if (nd.c) demote(nd.c);
              }
            };
            demote(children);
          }
          nodes.length = bi;
          const node = br.img
            ? { k: 'img', src: dest, title, c: children }
            : { k: 'link', href: dest, title, c: children };
          nodes.push(node);
          // rule (A): a formed link whose label ends with an unclosed
          // code span marks the start of the suppression zone
          if (labelHasUnclosedSpan(src, br.pos + (br.img ? 2 : 1), i) && endPos < minL1End) minL1End = endPos;
          linkLists.push(children);
          brackets.pop();
          // drop any brackets that were inside the link text
          for (let b = brackets.length - 1; b >= 0; b--) {
            if (brackets[b].pos > br.pos) brackets.splice(b, 1);
          }
          i = endPos; t0 = i; formed = true;
        }
      }
      if (!formed) {
        if (br) {
          // deactivate the bracket this ] tried to use
          const bi = brackets.indexOf(br);
          if (bi >= 0) brackets.splice(bi, 1);
          // a failed inline-link attempt: emphasis/strikethrough inside
          // the label stays literal (marked renders no emphasis in a
          // label whose link did not form); code spans still form. Mark
          // the label's top-level delimiter nodes; processEmphasis
          // skips them. Do not recurse into formed link/img children.
          if (src[i + 1] === '(') {
            const nbi = nodes.indexOf(br);
            for (let q = nbi + 1; q < nodes.length; q++) {
              if (nodes[q].k === 'delim') nodes[q].noEm = true;
            }
          }
        }
        t0 = i; // the ] itself is pending text (the text before it was flushed)
        i++; continue; // literal ]
      }
      continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i, run = 0;
      while (src[j] === ch) { j++; run++; }
      const { left, right } = flanking(src, i, j);
      let open, close;
      if (ch === '*') { open = left; close = right; }
      else {
        // _ can open only if left-flanking and (not right-flanking or
        // preceded by punctuation); can close only if right-flanking
        // and (not left-flanking or followed by punctuation)
        open = left && (!right || isPunct(src[i - 1] || ''));
        close = right && (!left || isPunct(src[j] || ''));
      }
      flushText(i);
      nodes.push({ k: 'delim', ch, len: run, open, close, pos: i });
      i = j; t0 = i; continue;
    }
    if (ch === '~') {
      let j = i, run = 0;
      while (src[j] === '~') { j++; run++; }
      // strikethrough delimiters are runs of 1 or 2 tildes; longer runs
      // are literal text (~~~ never strikes)
      if (run > 2) { i = j; continue; }
      const { left, right } = flanking(src, i, j);
      flushText(i);
      nodes.push({ k: 'delim', ch: '~', len: run, open: left, close: right, pos: i });
      i = j; t0 = i; continue;
    }
    // extended autolinks (www. / http(s):// / email)
    if (ch === 'w' || ch === 'h' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
      // the autolink stops at ] only when it sits inside a live link
      // label (innermost open bracket whose text-so-far holds no link);
      // inside a dead bracket the ] belongs to the URL (doc-08/12/22/37)
      let stopAtBracket = false;
      if (brackets.length) {
        const br = brackets[brackets.length - 1];
        const bi = nodes.indexOf(br);
        let hasLink = false;
        const scan = (list) => {
          for (const nd of list) {
            if (nd.k === 'link') { hasLink = true; return; }
            if (nd.c) scan(nd.c);
            if (hasLink) return;
          }
        };
        if (bi >= 0) scan(nodes.slice(bi + 1));
        stopAtBracket = !hasLink;
      }
      const ext = tryExtendedAutolink(src, i, stopAtBracket);
      if (ext) {
        // a bare email followed by _ is not an autolink unless the _ closes
        // an open emphasis run (there is an unmatched _ delimiter that can
        // open before it)
        if (ext.href.startsWith('mailto:') && src[ext.end] === '_') {
          let hasOpen = false;
          for (let q = nodes.length - 1; q >= 0; q--) {
            const nd = nodes[q];
            if (nd.k === 'delim' && nd.ch === '_' && nd.open) { hasOpen = true; break; }
          }
          if (!hasOpen) { i++; continue; }
        }
        flushText(i);
        nodes.push({ k: 'auto', href: ext.href, text: ext.text });
        i = ext.end; t0 = i; continue;
      }
    }
    i++;
  }
  flushText(n);
  return { nodes, linkLists, ctx: { minL1End: minL1End === Infinity ? -1 : minL1End, lastBt } };
}

// Recursively replace em/strong/del containers with their literal
// delimiter text (used by rule (A)'s post-pass). Does not cross into
// link/img children: emphasis inside a formed link stays formed.
function unformEm(list) {
  const out = [];
  for (const nd of list) {
    if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') {
      out.push({ k: 'delim', ch: nd.ch, len: nd.use });
      out.push(...unformEm(nd.c));
      out.push({ k: 'delim', ch: nd.ch, len: nd.use });
    } else out.push(nd);
  }
  return out;
}

function processEmphasis(nodes, ctx) {
  // Stack entries are {node, idx}: the delimiter node and its current
  // index in nodes. All stack entries sit before any splice point, so
  // their indices stay valid across splices.
  // ctx (main list only): {minL1End, lastBt} for rule (A). A closer is
  // in the suppression zone when minL1End <= closer.pos < lastBt.
  const inZone = (pos) => ctx && ctx.minL1End >= 0 && ctx.lastBt >= 0 &&
    pos !== undefined && pos >= ctx.minL1End && pos < ctx.lastBt;
  const stack = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.k !== 'delim') { i++; continue; }
    // a delimiter inside a failed inline-link label stays literal
    if (node.noEm) { i++; continue; }
    // A delimiter must not match itself: search for a closer first,
    // using only the openers that came before it, then push it as an
    // opener if it can open.
    if (node.close) {
      let si = stack.length - 1, opener = null, openerIdx = -1, use = 0;
      while (si >= 0) {
        const cand = stack[si].node;
        if (cand.ch === node.ch) {
          // odd-match rule (spec rule 9): if one of the two delimiters
          // can both open and close, their lengths must not sum to a
          // multiple of 3 (unless both are multiples of 3)
          const oneCanBoth = (cand.open && cand.close) || (node.open && node.close);
          const sumMult3 = (cand.len + node.len) % 3 === 0;
          const bothMult3 = cand.len % 3 === 0 && node.len % 3 === 0;
          if (oneCanBoth && sumMult3 && !bothMult3) { si--; continue; }
          // A single closer must not split a double opener when the
          // text right before it runs directly on from a just-closed
          // emphasis (no whitespace between that emphasis and the
          // text): `**a *so*other* d**` leaves the `*` after `other`
          // literal so the outer pair forms a strong, while
          // `**a *b* c* d**` (space after the inner emphasis) lets
          // the `*` match and form a nested emphasis.
          if (cand.len === 2 && node.len === 1) {
            const prev = nodes[i - 1];
            const prev2 = nodes[i - 2];
            if (prev && prev.k === 't' && prev.s.length > 0 && !isSpace(prev.s.charCodeAt(0)) &&
                prev2 && (prev2.k === 'em' || prev2.k === 'strong' || prev2.k === 'del')) { si--; continue; }
          }
          // A single opener/closer pair wrapping a just-closed strong
          // also stays literal when the strong's opening `**` was
          // preceded by whitespace (`*browser in so **change**in*`):
          // the text before the strong ends with a space. When the
          // strong runs directly on from text (`*foo**bar**baz*`,
          // cm-411) the outer pair does form an emphasis. Asterisks
          // only: underscore pairs (`_large **data**not_`) do form.
          // The blocked opener leaves the stack: its matching closer
          // was the one just refused, so a later closer (e.g. the
          // outer `**` in `**removes example *input **parse**parse*
          // release**`) must not pick it up as an emphasis opener.
          if (cand.len === 1 && node.len === 1 && cand.ch === '*' && node.ch === '*') {
            const prev = nodes[i - 1];
            const prev2 = nodes[i - 2];
            const prev3 = nodes[i - 3];
            if (prev && prev.k === 't' && prev.s.length > 0 && !isSpace(prev.s.charCodeAt(0)) &&
                prev2 && prev2.k === 'strong' &&
                (!prev3 || (prev3.k === 't' && prev3.s.length > 0 && isSpace(prev3.s.charCodeAt(prev3.s.length - 1))))) {
              stack.splice(si, 1); si--; continue;
            }
          }
          use = cand.len >= 2 && node.len >= 2 ? 2 : 1;
          if (cand.len < use) { si--; continue; }
          // rule (A): a closer in the suppression zone does not match
          // a bottom-of-stack opener (the span would be outermost);
          // the closer stays literal and the opener stays available
          // for a later closer. (A non-bottom opener still matches:
          // the span is nested, and the post-pass judges the outer.)
          if (si === 0 && inZone(node.pos)) { si--; continue; }
          opener = cand; openerIdx = stack[si].idx; break;
        }
        si--;
      }
      if (opener) {
        const oi = openerIdx, ci = i;
        const children = nodes.slice(oi + 1, ci);
        const tag = opener.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const container = { k: tag, c: children, ch: opener.ch, use, closerPos: node.pos };
        stack.length = si;
        const mid = [];
        if (opener.len > use) {
          const rem = { k: 'delim', ch: opener.ch, len: opener.len - use, open: opener.open, close: opener.close, pos: opener.pos };
          mid.push(rem);
          stack.push({ node: rem, idx: oi });
        }
        mid.push(container);
        let closerRem = null;
        if (node.len > use) {
          closerRem = { k: 'delim', ch: node.ch, len: node.len - use, open: node.open, close: node.close, pos: node.pos };
          // When the text right before the closer runs directly on from
          // a just-closed emphasis, a strong closer's leftover
          // delimiters stay inside the container (`**a *b*c***`
          // renders `<strong>a <em>b</em>c*</strong>`; with a space
          // before the closer, `**a *b* c***`, the leftover `*` goes
          // outside). Only for a strong (use 2), and only when no
          // opener with the same character is left on the stack for
          // the leftover to close: in `__because may __old 2*3*4
          // and____`, the leftover `__` must stay outside to close
          // the outer strong.
          const prev = nodes[ci - 1];
          const prev2 = nodes[ci - 2];
          let stackHasSame = false;
          for (let q = 0; q < stack.length; q++) if (stack[q].node.ch === node.ch) { stackHasSame = true; break; }
          if (use === 2 && !stackHasSame && prev && prev.k === 't' && prev.s.length > 0 && !isSpace(prev.s.charCodeAt(0)) &&
              prev2 && (prev2.k === 'em' || prev2.k === 'strong' || prev2.k === 'del')) {
            children.push(closerRem);
            closerRem = null;
          } else {
            mid.push(closerRem);
          }
        }
        nodes.splice(oi, ci - oi + 1, ...mid);
        if (closerRem) { i = oi + mid.length - 1; continue; }
        i = oi + mid.length;
        continue;
      }
    }
    if (node.open) stack.push({ node, idx: i });
    i++;
  }
  // rule (A) post-pass: unform any top-level em/strong/del container
  // whose closer is in the suppression zone (it was nested when it
  // formed, or its opener never closed). Nested containers inside a
  // forming outer stay formed; only a suppressed top-level container
  // is unformed, recursively.
  if (ctx && ctx.minL1End >= 0 && ctx.lastBt >= 0) {
    const out = [];
    for (const nd of nodes) {
      if ((nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') && inZone(nd.closerPos)) out.push(...unformEm([nd]));
      else out.push(nd);
    }
    nodes.length = 0;
    nodes.push(...out);
  }
}

function renderInlineNodes(nodes, out) {
  for (const node of nodes) {
    switch (node.k) {
      case 't': out.push(escText(node.s)); break;
      case 'amp': out.push('&amp;'); break;
      case 'code': out.push('<code>', escCode(node.s), '</code>'); break;
      case 'html': out.push(node.s); break;
      case 'br': out.push('<br>'); break;
      case 'soft': out.push('\n'); break;
      case 'em': out.push('<em>'); renderInlineNodes(node.c, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInlineNodes(node.c, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInlineNodes(node.c, out); out.push('</del>'); break;
      case 'link': {
        out.push('<a href="', cleanHref(node.href), '"');
        if (node.title !== null && node.title !== undefined) out.push(' title="', escAttr(node.title), '"');
        out.push('>');
        renderInlineNodes(node.c, out);
        out.push('</a>');
        break;
      }
      case 'img': {
        out.push('<img src="', cleanHref(node.src), '" alt="', escAttr(plainText(node.c)), '"');
        if (node.title !== null && node.title !== undefined) out.push(' title="', escAttr(node.title), '"');
        out.push('>');
        break;
      }
      case 'auto': {
        out.push('<a href="', cleanHref(node.href), '">', escText(node.text), '</a>');
        break;
      }
      case 'delim': out.push(node.ch.repeat(node.len)); break;
      case 'bracket': out.push(node.img ? '![' : '['); break;
    }
  }
}

// Plain text of inline nodes (for image alt text): formatting stripped,
// entities and HTML kept raw (escaped later by escAttr).
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 't': out += node.s; break;
      case 'amp': out += '&'; break;
      case 'code': out += node.s; break;
      case 'html': out += node.s; break;
      case 'br': case 'soft': out += '\n'; break;
      case 'em': case 'strong': case 'del': case 'link': case 'img':
        out += plainText(node.c); break;
      case 'delim': out += node.ch.repeat(node.len); break;
      case 'bracket': out += node.img ? '![' : '['; break;
      case 'auto': out += node.text; break;
    }
  }
  return out;
}

function parseInline(src, refs) {
  if (src === '') return '';
  const { nodes, linkLists, ctx } = scanInline(src, refs);
  processEmphasis(nodes, ctx);
  for (const list of linkLists) processEmphasis(list);
  const out = [];
  renderInlineNodes(nodes, out);
  return out.join('');
}

// ---- block rendering ---------------------------------------------------

function renderBlocks(blocks, refs, out, tight) {
  for (const b of blocks) {
    switch (b.t) {
      case 'para': {
        if (tight) out.push(parseInline(b.text, refs));
        else out.push('<p>', parseInline(b.text, refs), '</p>\n');
        break;
      }
      case 'heading': {
        out.push('<h', String(b.level), '>', parseInline(b.text, refs), '</h', String(b.level), '>\n');
        break;
      }
      case 'code': case 'fence': {
        out.push('<pre><code');
        if (b.info) out.push(' class="language-', escAttr(b.info), '"');
        out.push('>', escCode(b.text), '</code></pre>\n');
        break;
      }
      case 'html': {
        out.push(b.text);
        break;
      }
      case 'hr': out.push('<hr>\n'); break;
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderBlocks(b.children, refs, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<', tag);
        if (b.ordered && b.start !== 1) out.push(' start="', String(b.start), '"');
        out.push('>\n');
        for (const item of b.children) {
          const body = [];
          // task list: a leading [ ] / [x] in the first paragraph becomes
          // a checkbox; the marker is stripped from the paragraph text
          let taskHtml = null;
          const first = item.children[0];
          if (first && first.t === 'para') {
            const m = /^\[([ xX])\](?:[ \t]+|\n|$)/.exec(first.text);
            if (m) {
              const checked = m[1] === 'x' || m[1] === 'X';
              taskHtml = checked
                ? '<input checked="" disabled="" type="checkbox"> '
                : '<input disabled="" type="checkbox"> ';
              const saved = first.text;
              first.text = first.text.slice(m[0].length);
              renderBlocks(item.children, refs, body, !b.loose);
              first.text = saved;
              if (b.loose) {
                const pIdx = body.indexOf('<p>');
                if (pIdx >= 0) body.splice(pIdx + 1, 0, taskHtml);
                else body.unshift(taskHtml);
              } else {
                body.unshift(taskHtml);
              }
              out.push('<li>', ...body, '</li>\n');
              continue;
            }
          }
          renderBlocks(item.children, refs, body, !b.loose);
          out.push('<li>');
          out.push(...body);
          out.push('</li>\n');
        }
        out.push('</', tag, '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let i = 0; i < b.header.length; i++) {
          out.push('<th');
          const a = b.align[i];
          if (a === 'left') out.push(' align="left"');
          else if (a === 'right') out.push(' align="right"');
          else if (a === 'center') out.push(' align="center"');
          out.push('>', parseInline(b.header[i], refs), '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let i = 0; i < b.header.length; i++) {
              out.push('<td');
              const a = b.align[i];
              if (a === 'left') out.push(' align="left"');
              else if (a === 'right') out.push(' align="right"');
              else if (a === 'center') out.push(' align="center"');
              out.push('>', parseInline(row[i] || '', refs), '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody></table>\n');
        } else {
          out.push('</table>\n');
        }
        break;
      }
    }
  }
}

// ---- entry point -------------------------------------------------------

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  src = src.replace(/\r\n?/g, '\n');
  src = src.replace(/\u0000/g, '\uFFFD');
  inAnchor = false;
  const { root, refs } = parseBlocks(src);
  const out = [];
  renderBlocks(root.children, refs, out);
  return out.join('');
}
