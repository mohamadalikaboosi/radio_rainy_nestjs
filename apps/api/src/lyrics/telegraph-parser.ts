import { HTMLElement, Node as HtmlNode, NodeType, parse } from 'node-html-parser';

/** Telegraph's own content node format (also used as our neutral tree). */
export type TgNode = string | { tag: string; attrs?: Record<string, string>; children?: TgNode[] };

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'pre', 'div', 'aside', 'ul', 'ol', 'section']);
const SKIP_TAGS = new Set(['img', 'video', 'iframe', 'figure', 'figcaption', 'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'address', 'button', 'form']);

/**
 * Converts a node tree to plain text. Structure-agnostic: only tag *kinds* matter (block vs inline vs <br>),
 * no CSS class/id selectors. Consecutive blocks are separated by a blank line (stanzas).
 */
export function nodesToText(nodes: readonly TgNode[]): string {
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    out.push(current);
    current = '';
  };
  const walk = (node: TgNode): void => {
    if (typeof node === 'string') {
      current += node;
      return;
    }
    const tag = node.tag.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      current += '\n';
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock && current.trim().length > 0) flush();
    else if (isBlock) current = '';
    for (const c of node.children ?? []) walk(c);
    if (isBlock && current.trim().length > 0) flush();
    else if (isBlock) current = '';
  };
  for (const n of nodes) walk(n);
  if (current.trim().length > 0) flush();
  return out
    .map((block) =>
      block
        .replace(/ /g, ' ')
        .split('\n')
        .map((l) => l.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/^\n+|\n+$/g, ''),
    )
    .filter((b) => b.length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToNodes(el: HtmlNode): TgNode[] {
  if (el.nodeType === NodeType.TEXT_NODE) return [el.text];
  if (el.nodeType !== NodeType.ELEMENT_NODE) return [];
  const e = el as HTMLElement;
  return [{ tag: e.rawTagName ?? 'div', children: e.childNodes.flatMap(htmlToNodes) }];
}

/** Fallback when the JSON API is unavailable: parse the public HTML page. */
export function htmlToText(html: string): string {
  const root = parse(html, { comment: false });
  const container = root.querySelector('article') ?? root.querySelector('body') ?? root;
  // Telegraph puts title (h1) and author (address) inside the article; SKIP_TAGS/first h1 handling removes them.
  const nodes = container.childNodes.flatMap(htmlToNodes).filter((n) => !(typeof n !== 'string' && n.tag.toLowerCase() === 'h1'));
  return nodesToText(nodes);
}
