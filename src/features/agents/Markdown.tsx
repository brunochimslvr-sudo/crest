import { useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { t } from "../../i18n";
import { parseMarkdown, type Block, type Span } from "./replyMarkdown";

/** Puts text on the clipboard and says for a moment whether it worked. */
export function useCopy(): [boolean | null, (text: string) => void] {
  const [state, setState] = useState<boolean | null>(null);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => true, () => false).then((ok) => {
      setState(ok);
      window.setTimeout(() => setState(null), 1600);
    });
  };
  return [state, copy];
}

export function CopyButton({ text, label, className = "" }: { text: string; label?: string; className?: string }) {
  const [state, copy] = useCopy();
  const name = state === null ? (label ?? t("Kopieren")) : state ? t("Kopiert") : t("Kopieren fehlgeschlagen");
  return (
    <button type="button" aria-label={name} title={name} onClick={() => copy(text)}
      className={`pressable pressable-fill inline-flex items-center gap-1 rounded px-1 text-caption text-label-3 hover:text-label-2 ${className}`}>
      {state ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />}
    </button>
  );
}

function Spans({ spans }: { spans: Span[] }): ReactNode {
  return spans.map((span, i) => {
    switch (span.type) {
      case "text": return span.text;
      case "code": return <code key={i} className="rounded bg-fill-2 px-1 py-px font-mono text-[0.92em]">{span.text}</code>;
      case "bold": return <strong key={i} className="font-semibold"><Spans spans={span.children} /></strong>;
      case "italic": return <em key={i}><Spans spans={span.children} /></em>;
      // A link is only its text: nothing in a reply opens a page by itself.
      case "link": return <span key={i} title={span.href} className="underline decoration-label-3/50 underline-offset-2">{span.text}</span>;
    }
  });
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "paragraph": return <p className="whitespace-pre-wrap break-words"><Spans spans={block.spans} /></p>;
    case "heading": return <p className="break-words font-semibold"><Spans spans={block.spans} /></p>;
    case "quote": return <blockquote className="whitespace-pre-wrap break-words border-s-2 border-label-3/30 ps-2.5 text-label-2"><Spans spans={block.spans} /></blockquote>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className={`flex flex-col gap-0.5 ps-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, i) => <li key={i} className="break-words ps-0.5"><Spans spans={item} /></li>)}
        </List>
      );
    }
    case "code": return (
      <div className="min-w-0 overflow-hidden rounded-[10px] bg-fill-2">
        <div className="flex h-6 items-center ps-2.5 pe-1 text-caption text-label-3">
          <span className="min-w-0 flex-1 truncate">{block.lang}</span>
          <CopyButton text={block.text} label={t("Code kopieren")} />
        </div>
        <pre tabIndex={0} className="max-h-60 select-text overflow-auto overscroll-contain px-2.5 pb-2 font-mono text-footnote leading-snug text-label [scrollbar-width:thin]"><code>{block.text}</code></pre>
      </div>
    );
  }
}

/** A reply as formatted text. The blocks come from a parser that makes no HTML, so a reply cannot inject any. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-body text-label">
      {parseMarkdown(text).map((block, i) => <BlockView key={i} block={block} />)}
    </div>
  );
}
