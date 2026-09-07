import { Component, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatexBase from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Check, Copy } from 'lucide-react';
import { unwrapMarkdownFence, normalizeLatexDelimiters } from './markdown-utils';
import { sanitizeControlTokens } from '../features/chat/leak-sanitizer';

/* ------------------------------------------------------------------ *
   Production markdown renderer for chat bubbles.
   - GFM (tables, task lists, strikethrough, autolinks)
   - KaTeX (inline $...$, \(...\) and display $$...$$, \[...\])
   - highlight.js syntax highlighting + per-block copy button
   - LaTeX errors render inline (never crash the bubble, stream-safe)
   - A single wrapping ```markdown fence is unwrapped automatically
   * ------------------------------------------------------------------ */

interface MdNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MdNode[];
}

function hastToText(node: MdNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'raw') return node.value ?? '';
  return (node.children ?? []).map(hastToText).join('');
}

function codeInfo(node: MdNode | undefined): { lang: string; raw: string } {
  const code = (node?.children ?? []).find((c) => c?.tagName === 'code');
  const classes = code?.properties?.className;
  const cls = Array.isArray(classes) ? classes.join(' ') : String(classes ?? '');
  const lang = /language-([\w-]+)/.exec(cls)?.[1] ?? 'text';
  return { lang, raw: hastToText(code ?? node) };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="codeblock-copy"
      aria-label="Copy code"
      title="Copy code"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a className="md-a" target="_blank" rel="noreferrer" {...props} />,
  p: ({ node: _node, ...props }) => <p className="md-p" {...props} />,
  h1: ({ node: _node, ...props }) => <h1 className="md-h1" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="md-h2" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="md-h3" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="md-h4" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="md-h5" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="md-h6" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="md-ul" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="md-ol" {...props} />,
  li: ({ node: _node, ...props }) => <li className="md-li" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="md-quote" {...props} />,
  hr: ({ node: _node }) => <hr className="md-hr" />,
  del: ({ node: _node, ...props }) => <del className="md-del" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="md-strong" {...props} />,
  em: ({ node: _node, ...props }) => <em className="md-em" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table className="md-table" {...props} />
    </div>
  ),
  tr: ({ node: _node, ...props }) => <tr className="md-tr" {...props} />,
  th: ({ node: _node, ...props }) => <th className="md-th" {...props} />,
  td: ({ node: _node, ...props }) => <td className="md-td" {...props} />,
  img: ({ node: _node, ...props }) => (
    <img
      className="md-img"
      loading="lazy"
      onClick={() => {
        if (typeof props.src === 'string' && /^https?:/.test(props.src)) window.open(props.src, '_blank');
      }}
      {...props}
    />
  ),
  input: ({ node: _node, checked }) => (
    <input
      type="checkbox"
      className="md-task-check"
      defaultChecked={checked === true}
      key={checked === true ? 'on' : 'off'}
      readOnly
      aria-label="task checkbox"
    />
  ),
  code: ({ node: _node, className, children, ...props }) => (
    <code className={['md-code', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </code>
  ),
  pre: ({ node, children }) => {
    const { lang, raw } = codeInfo(node as MdNode | undefined);
    return (
      <div className="codeblock">
        <div className="codeblock-head">
          <span className="codeblock-lang">{lang || 'code'}</span>
          <CopyButton text={raw} />
        </div>
        <pre className="md-pre">{children}</pre>
      </div>
    );
  },
};

/** Safety net: if a plugin chokes on unusual content, fall back to raw text
 *  instead of taking the whole bubble down. Resets when the stream advances. */
class MdBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean; lastText: string }> {
  state = { failed: false, lastText: '' };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { text: string },
    state: { failed: boolean; lastText: string },
  ): Partial<{ failed: boolean; lastText: string }> | null {
    if (state.lastText !== props.text) {
      return { failed: false, lastText: props.text };
    }
    return null;
  }
  render(): ReactNode {
    if (this.state.failed) return <pre className="md-fallback">{this.props.text}</pre>;
    return this.props.children;
  }
}

export default function ChatMarkdown({ text }: { text: string }) {
  const processed = sanitizeControlTokens(normalizeLatexDelimiters(unwrapMarkdownFence(text)));
  
  // KaTeX is now a STATIC import — no more first-render flash of raw LaTeX and
  // no more intermittent silent failure from a broken dynamic import(). The CSS
  // was already static (line 6) so there was never a real reason to lazy-load
  // the JS half.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugins: any[] = [
    [rehypeKatexBase, { output: 'html', strict: false, trust: false, maxSize: 100, errorColor: '#e0645a' }],
    [rehypeHighlight, { detect: false, plainText: ['txt', 'text', 'plaintext', 'md', 'markdown', 'log'] }],
  ];

  return (
    <MdBoundary text={processed}>
      <div className="md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rehypePlugins={plugins as any}
          components={components}
        >
          {processed}
        </ReactMarkdown>
      </div>
    </MdBoundary>
  );
}
