// A deliberately small CSS subset for <style> blocks in SVG files: simple and compound
// selectors (type, .class, #id, `path.a.b#c`, `*`), comma lists, specificity + source order.
// Anything else (combinators, pseudo classes, attribute selectors, at-rules) is skipped.

export interface Decl { prop: string; value: string; important: boolean }
export interface Compound { tag: string | null; id: string | null; classes: string[] }
export interface Rule { sel: Compound; spec: number; order: number; decls: Decl[] }

/** split on `sep` at the top level (outside parentheses and quotes) */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

export function parseDeclarations(s: string | null | undefined): Decl[] {
  if (!s) return [];
  const out: Decl[] = [];
  for (const part of splitTop(s, ';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!prop || !value) continue;
    let important = false;
    const m = /\s*!\s*important\s*$/i.exec(value);
    if (m) { important = true; value = value.slice(0, m.index).trim(); }
    out.push({ prop, value, important });
  }
  return out;
}

function parseCompound(s: string): Compound | null {
  const m = /^(\*|[a-zA-Z_][\w-]*(?:\|[\w-]+)?)?((?:[.#][\w-]+)*)$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const c: Compound = { tag: null, id: null, classes: [] };
  if (m[1] && m[1] !== '*') c.tag = m[1].toLowerCase().replace(/^.*\|/, '');
  for (const p of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (p[0] === '#') c.id = p.slice(1);
    else c.classes.push(p.slice(1));
  }
  return c;
}

export function parseStylesheet(cssText: string, warn: (msg: string) => void, orderBase = 0): Rule[] {
  let css = cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->|<!\[CDATA\[|\]\]>/g, '');
  const rules: Rule[] = [];
  let order = orderBase;
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let prelude = css.slice(i, open).trim();
    // statement at-rules (@import ...;) in front of this block
    while (prelude.startsWith('@') && prelude.includes(';')) prelude = prelude.slice(prelude.indexOf(';') + 1).trim();
    // find the matching close brace
    let depth = 1, j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    const body = css.slice(open + 1, depth === 0 ? j - 1 : j);
    i = j;
    if (prelude.startsWith('@')) { warn(`CSS at-rule ${prelude.split(/\s/)[0]} ignored`); continue; }
    const decls = parseDeclarations(body);
    for (const raw of splitTop(prelude, ',')) {
      const selText = raw.trim();
      if (!selText) continue;
      const sel = parseCompound(selText);
      if (!sel) { warn(`Unsupported CSS selector "${selText}" ignored`); continue; }
      const spec = (sel.id ? 10000 : 0) + sel.classes.length * 100 + (sel.tag ? 1 : 0);
      rules.push({ sel, spec, order: order++, decls });
    }
  }
  return rules;
}

export function matches(sel: Compound, tag: string, id: string | null, classes: string[]): boolean {
  if (sel.tag && sel.tag !== tag) return false;
  if (sel.id && sel.id !== id) return false;
  for (const c of sel.classes) if (!classes.includes(c)) return false;
  return true;
}
