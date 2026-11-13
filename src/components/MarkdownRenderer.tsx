import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { parseMarkdownBlocks } from '../utils/markdown';

interface MarkdownRendererProps {
  content: string;
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={keyIdx++}
          className="px-1.5 py-0.5 rounded text-[0.85em] font-mono"
          style={{ backgroundColor: 'var(--code-bg)', color: 'var(--text-primary)' }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={keyIdx++} className="font-semibold" style={{ color: 'var(--text-primary)' }}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={keyIdx++} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const safeHref = /^https?:\/\//i.test(linkMatch[2]) ? linkMatch[2] : '#';
        parts.push(
          <a
            key={keyIdx++}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
            style={{ color: 'var(--accent-primary)' }}
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="my-3 rounded-lg overflow-hidden border"
      style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--code-bg)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-xs border-b"
        style={{
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-muted)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-xs transition-colors hover:opacity-80 cursor-pointer whitespace-nowrap shrink-0"
          style={{ color: 'var(--text-secondary)' }}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[13px] leading-relaxed font-mono">
        <code style={{ color: 'var(--text-primary)' }}>{code}</code>
      </pre>
    </div>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="space-y-3 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const sizeClass =
              block.level === 1
                ? 'text-lg font-semibold mt-4'
                : block.level === 2
                ? 'text-base font-semibold mt-3'
                : 'text-sm font-semibold mt-2';
            return (
              <h4
                key={idx}
                className={`${sizeClass} font-display`}
                style={{ color: 'var(--text-primary)' }}
              >
                {renderInline(block.text)}
              </h4>
            );
          }
          case 'code':
            return <CodeBlock key={idx} lang={block.lang} code={block.code} />;
          case 'blockquote':
            return (
              <blockquote
                key={idx}
                className="px-3.5 py-2.5 rounded-lg border text-sm"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                {renderInline(block.text)}
              </blockquote>
            );
          case 'list':
            return block.ordered ? (
              <ol key={idx} className="list-decimal pl-5 space-y-1">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={idx} className="list-disc pl-5 space-y-1">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div
                key={idx}
                className="overflow-x-auto rounded-lg border"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <table className="w-full text-xs text-left border-collapse">
                  <thead style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                    <tr>
                      {block.headers.map((h, hIdx) => (
                        <th
                          key={hIdx}
                          className="px-3 py-2 font-semibold border-b"
                          style={{ borderColor: 'var(--border-subtle)' }}
                        >
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className="border-b last:border-b-0"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        {row.map((cell, cIdx) => (
                          <td key={cIdx} className="px-3 py-2 align-top">
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'paragraph':
          default:
            return (
              <p key={idx} className="leading-relaxed">
                {renderInline(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
};
