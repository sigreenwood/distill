import React, { useMemo } from 'react';
import { marked, type Token, type Tokens } from 'marked';

export function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...text.matchAll(new RegExp(escaped, 'gi'))];
  if (!matches.length) return text;
  const parts: React.ReactNode[] = [];
  let start = 0;
  for (const match of matches) {
    const index = match.index!;
    parts.push(text.slice(start, index));
    parts.push(<mark data-match key={index}>{match[0]}</mark>);
    start = index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

function renderTokens(tokens: Token[], query: string): React.ReactNode {
  return tokens.map((token, index) => {
    const childTokens = 'tokens' in token ? token.tokens : undefined;
    const children = () => renderTokens(childTokens ?? [], query);
    const text = () => highlightText('text' in token ? token.text : token.raw, query);
    let content: React.ReactNode;
    switch (token.type) {
      case 'space': case 'def': content = null; break;
      case 'heading': content = React.createElement(`h${token.depth}`, null, children()); break;
      case 'paragraph': content = <p>{children()}</p>; break;
      case 'strong': content = <strong>{children()}</strong>; break;
      case 'em': content = <em>{children()}</em>; break;
      case 'del': content = <del>{children()}</del>; break;
      case 'codespan': content = <code>{text()}</code>; break;
      case 'code': content = <pre><code>{text()}</code></pre>; break;
      case 'blockquote': content = <blockquote>{children()}</blockquote>; break;
      case 'br': content = <br />; break;
      case 'hr': content = <hr />; break;
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => <li key={i}>
          {item.task && <span aria-label={item.checked ? 'Completed' : 'Not completed'}>{item.checked ? '☑ ' : '☐ '}</span>}
          {renderTokens(item.tokens, query)}
        </li>);
        content = list.ordered ? <ol start={Number(list.start) || 1}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        content = <div className="reader-table"><table>
          <thead><tr>{table.header.map((cell, i) => <th key={i}>{renderTokens(cell.tokens, query)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{renderTokens(cell.tokens, query)}</td>)}</tr>)}</tbody>
        </table></div>;
        break;
      }
      // Meeting content is untrusted. Render links and images as text; never
      // execute embedded HTML or load external resources from a recording.
      case 'link': content = <span>{children()} ({highlightText(token.href, query)})</span>; break;
      case 'image': content = <span>[Image: {text()}]</span>; break;
      case 'html': content = text(); break;
      default: content = childTokens ? children() : text();
    }
    return <React.Fragment key={index}>{content}</React.Fragment>;
  });
}

export function MeetingText({ text, query, markdown }: { text: string; query: string; markdown: boolean }) {
  const tokens = useMemo(() => markdown ? marked.lexer(text) : [], [text, markdown]);
  return markdown ? <>{renderTokens(tokens, query)}</> : <div className="reader-transcript">{highlightText(text, query)}</div>;
}
