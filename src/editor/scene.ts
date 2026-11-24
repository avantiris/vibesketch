import type { Doc, Node } from '../core/model.ts';
import { maskDef, renderNode } from '../core/render.ts';
import type { Attrs, RenderCtx, VEl } from '../core/render.ts';
import { textLayoutVersion } from '../core/text.ts';
import { ensureFont } from './fonts.ts';

// Incremental SVG DOM renderer. Docs are immutable, so a node whose object identity is
// unchanged needs no work; a full sync is a cheap walk over the page tree.

const NS = 'http://www.w3.org/2000/svg';

export function createEl(v: VEl): SVGElement {
  const el = document.createElementNS(NS, v.tag);
  setAttrs(el, v.attrs);
  for (const c of v.children ?? []) el.append(typeof c === 'string' ? c : createEl(c));
  return el;
}

function setAttrs(el: Element, attrs: Attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === '') el.removeAttribute(k);
    else if (k === 'xml:space') el.setAttributeNS('http://www.w3.org/XML/1998/namespace', k, String(v));
    else el.setAttribute(k, String(v));
  }
}

interface Rec {
  g: SVGGElement;
  node: Node | null;
  attrKeys: string[];
  defs: SVGElement | null;
  /** layout signature of a group's children */
  sig: string;
  textV: number;
  gen: number;
}

export const domRef = (id: string) => `n${id}`;

export class Scene {
  private recs = new Map<string, Rec>();
  private gen = 0;
  private root: SVGGElement;
  private rootSig = '';
  private ctx: RenderCtx;
  private hidden: string | null = null;

  constructor(root: SVGGElement, assetUrl: (key: string) => string) {
    this.root = root;
    this.ctx = { assetUrl, ref: domRef, slices: true };
  }

  /** forget everything (project switch: asset URLs change) */
  reset() {
    this.recs.clear();
    this.root.replaceChildren();
    this.rootSig = '';
  }

  /** hide one node's rendering (the text being edited is shown by a textarea instead) */
  setHidden(id: string | null) {
    if (this.hidden === id) return;
    const prev = this.hidden && this.recs.get(this.hidden);
    if (prev) prev.g.style.visibility = '';
    this.hidden = id;
    const cur = id && this.recs.get(id);
    if (cur) cur.g.style.visibility = 'hidden';
  }

  sync(doc: Doc, pageId: string) {
    const page = doc.pages.find(p => p.id === pageId);
    if (!page) return;
    const gen = ++this.gen;
    for (const id of page.children) this.syncNode(doc, id, gen);
    this.rootSig = this.layout(doc, this.root, null, page.children, this.rootSig);
    for (const [id, rec] of this.recs) if (rec.gen !== gen) { rec.g.remove(); this.recs.delete(id); }
  }

  private syncNode(doc: Doc, id: string, gen: number) {
    const n = doc.nodes[id];
    if (!n) return;
    let rec = this.recs.get(id);
    if (!rec) {
      const g = document.createElementNS(NS, 'g');
      g.dataset.id = id;
      rec = { g, node: null, attrKeys: [], defs: null, sig: '', textV: -1, gen };
      this.recs.set(id, rec);
      if (this.hidden === id) g.style.visibility = 'hidden';
    }
    rec.gen = gen;
    const tv = textLayoutVersion();
    // groups with effects depend on their children's bounds (filter region)
    const dirty = rec.node !== n || (n.type === 'text' && rec.textV !== tv) || (n.type === 'group' && n.effects.length > 0);
    if (dirty) {
      if (n.type === 'text') void ensureFont(n.font);
      const r = renderNode(doc, n, this.ctx);
      const attrs: Attrs = { ...r.attrs, display: n.visible ? undefined : 'none', 'pointer-events': n.locked ? 'none' : undefined };
      for (const k of rec.attrKeys) if (!(k in attrs)) rec.g.removeAttribute(k);
      setAttrs(rec.g, attrs);
      rec.attrKeys = Object.keys(attrs);
      if (n.type !== 'group') {
        const kids: SVGElement[] = [];
        if (r.defs.length) kids.push(createEl({ tag: 'defs', attrs: {}, children: r.defs }));
        for (const c of r.content) kids.push(createEl(c));
        rec.g.replaceChildren(...kids);
      } else {
        if (rec.defs) { rec.defs.remove(); rec.defs = null; }
        if (r.defs.length) { rec.defs = createEl({ tag: 'defs', attrs: {}, children: r.defs }); rec.g.prepend(rec.defs); }
      }
      rec.node = n;
      rec.textV = tv;
    }
    if (n.type === 'group') {
      for (const c of n.children) this.syncNode(doc, c, gen);
      rec.sig = this.layout(doc, rec.g, rec.defs, n.children, rec.sig);
    }
  }

  /** Place child elements into `container` in order, nesting everything after a mask node
   *  inside a masked <g>. Only touches the DOM when the arrangement changed. */
  private layout(doc: Doc, container: SVGElement, keep: SVGElement | null, children: string[], prevSig: string): string {
    let sig = '';
    let hasMask = false;
    for (const id of children) {
      const n = doc.nodes[id];
      if (!n) continue;
      const isMask = !!n.mask && n.visible;
      hasMask ||= isMask;
      sig += id + (isMask ? '*' : '') + ',';
    }
    // mask geometry feeds the <mask> region, so masks re-layout whenever they change
    if (hasMask) for (const id of children) { const n = doc.nodes[id]; if (n?.mask) sig += `|${this.maskStamp(n)}`; }
    if (sig === prevSig) return sig;
    for (const c of [...container.children]) if (c !== keep) c.remove();
    let target: Element = container;
    for (const id of children) {
      const n = doc.nodes[id], rec = this.recs.get(id);
      if (!n || !rec) continue;
      if (n.mask && n.visible) {
        const mid = `${domRef(id)}-mask`;
        const def = maskDef(doc, n, mid, { tag: 'g', attrs: {} });
        const mask = document.createElementNS(NS, 'mask');
        setAttrs(mask, def.attrs);
        mask.append(rec.g);
        const wrap = document.createElementNS(NS, 'g');
        wrap.setAttribute('mask', `url(#${mid})`);
        target.append(mask, wrap);
        target = wrap;
      } else target.append(rec.g);
    }
    return sig;
  }

  private stamps = new WeakMap<Node, number>();
  private stampSeq = 0;
  private maskStamp(n: Node): number {
    let s = this.stamps.get(n);
    if (!s) { s = ++this.stampSeq; this.stamps.set(n, s); }
    return s;
  }

  elementOf(id: string): SVGGElement | undefined { return this.recs.get(id)?.g; }
}
