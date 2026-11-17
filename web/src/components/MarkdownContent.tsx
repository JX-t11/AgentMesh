import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { AgentView } from '../types/domain';
import { Icon } from './Icon';

type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'paragraph'; text: string };

export function extractPlainExcerpt(markdown: string, maxChars = 160): string {
  const plain = markdown
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, ' ')
    .replace(/```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= maxChars) {
    return plain;
  }
  return `${plain.slice(0, maxChars).trimEnd()}…`;
}

interface MarkdownContentProps {
  content: string;
  agentsBySlug?: ReadonlyMap<string, AgentView>;
  onInspectAgent?: (agentId: string) => void;
}

export function MarkdownContent({
  content,
  agentsBySlug,
  onInspectAgent,
}: MarkdownContentProps) {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="md-content">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
            return (
              <Tag key={idx} className={`md-heading md-h${block.level}`}>
                {renderInlineNodes(block.text, agentsBySlug, onInspectAgent)}
              </Tag>
            );
          }
          case 'code':
            return <CodeBlock key={idx} language={block.language} code={block.code} />;
          case 'quote':
            return (
              <blockquote key={idx} className="md-quote">
                {renderInlineNodes(block.text, agentsBySlug, onInspectAgent)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={idx} className="md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInlineNodes(item, agentsBySlug, onInspectAgent)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx} className="md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInlineNodes(item, agentsBySlug, onInspectAgent)}</li>
                ))}
              </ol>
            );
          case 'paragraph':
            return (
              <p key={idx} className="md-paragraph">
                {renderInlineNodes(block.text, agentsBySlug, onInspectAgent)}
              </p>
            );
        }
      })}
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span>{language || 'code'}</span>
        <button
          type="button"
          className="md-copy-btn"
          aria-label={copied ? '已复制代码' : '复制代码'}
          onClick={() => void handleCopy()}
        >
          <Icon name={copied ? 'check' : 'copy'} />
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>
      <pre className="md-code-pre" tabIndex={0} role="region" aria-label={`${language || '纯文本'}代码`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fenceMatch = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line.trim());
    if (fenceMatch) {
      const language = fenceMatch[1] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length as 1 | 2 | 3,
        text: headingMatch[2]!.trim(),
      });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^(#{1,3})\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !/^[-*+]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!)
    ) {
      paragraphLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text: raw }];
}

const INLINE_TOKEN_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|@[a-zA-Z0-9][a-zA-Z0-9_-]{1,63})/g;

function renderInlineNodes(
  text: string,
  agentsBySlug?: ReadonlyMap<string, AgentView>,
  onInspectAgent?: (agentId: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const index = match.index ?? 0;
    const token = match[0];

    if (index > cursor) {
      nodes.push(<Fragment key={key++}>{text.slice(cursor, index)}</Fragment>);
    }

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('@')) {
      const prevChar = index > 0 ? text[index - 1]! : '';
      const slug = token.slice(1).toLowerCase();
      const matchedAgent = /[a-zA-Z0-9._-]/.test(prevChar)
        ? undefined
        : agentsBySlug?.get(slug);

      if (matchedAgent && onInspectAgent) {
        nodes.push(
          <button
            key={key++}
            type="button"
            className="inline-mention-btn"
            onClick={() => onInspectAgent(matchedAgent.id)}
          >
            {token}
          </button>,
        );
      } else {
        nodes.push(<Fragment key={key++}>{token}</Fragment>);
      }
    }

    cursor = index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(cursor)}</Fragment>);
  }

  return nodes.length > 0 ? nodes : [text];
}
