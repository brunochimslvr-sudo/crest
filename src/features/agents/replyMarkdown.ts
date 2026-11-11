/*
 * A small, safe Markdown reader for the replies of an agent: it produces blocks and spans, never HTML.
 * Links are kept as their text (the address in a title), so nothing in a reply can open a page by itself.
 */

export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; children: Span[] }
  | { type: "italic"; children: Span[] }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Span[][] }
  | { type: "quote"; spans: Span[] };

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Splits a reply into blocks. A code block that is still being written (no closing fence yet) stays a code block. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", spans: parseSpans(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ type: "code", lang: fence[1], text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: Math.min(3, heading[1].length) as 1 | 2 | 3, spans: parseSpans(heading[2]) });
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      flush();
      const items: Span[][] = [];
      const pattern = ordered ? NUMBERED : BULLET;
      for (; i < lines.length; i++) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        items.push(parseSpans(item[1]));
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length; i++) {
        const part = QUOTE.exec(lines[i]);
        if (!part) break;
        quoted.push(part[1]);
      }
      i--;
      blocks.push({ type: "quote", spans: parseSpans(quoted.join("\n")) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** `code`, **bold**, *italic* and [text](address) inside one block. Anything unclosed stays as it was typed. */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let plain = "";
  const push = () => {
    if (plain) spans.push({ type: "text", text: plain });
    plain = "";
  };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^`([^`\n]+)`/.exec(rest))) {
      push();
      spans.push({ type: "code", text: match[1] });
    } else if ((match = /^\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*/.exec(rest))) {
      push();
      spans.push({ type: "bold", children: parseSpans(match[1]) });
    } else if ((match = /^(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/.exec(rest)) && (i === 0 || !/[\w*]/.test(text[i - 1]))) {
      push();
      spans.push({ type: "italic", children: parseSpans(match[1]) });
    } else if ((match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      push();
      spans.push({ type: "link", text: match[1], href: match[2] });
    } else {
      plain += text[i];
      i++;
      continue;
    }
    i += match[0].length;
  }
  push();
  return spans;
}
