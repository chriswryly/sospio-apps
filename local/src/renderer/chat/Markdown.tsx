import { Fragment, type ReactNode } from "react";

// Formats an assistant reply's common markdown as React elements. It never produces raw HTML: every piece of the
// model's text ends up as a React text node, so a reply cannot inject markup or script. Links are shown as their
// text followed by the address in parentheses, not as clickable links. Anything unrecognised stays literal text.

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" }
  | { kind: "paragraph"; lines: string[] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const starts = (line: string) =>
    FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || RULE.test(line) ||
    QUOTE.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const marker = line.trim().slice(0, 3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence, or the end of a reply that is still streaming
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ kind: "rule" }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    const bullet = BULLET.exec(line), numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i]);
        if (match) { items.push(ordered ? match[2] : match[1]); i++; continue; }
        // An indented line continues the item above it; a nested list is shown flattened into that item.
        if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1] += "\n" + lines[i].trim(); i++; continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !(paragraph.length && starts(lines[i]))) paragraph.push(lines[i++]);
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index!;
    if (at > last) out.push(text.slice(last, at));
    if (match[2] !== undefined) out.push(<code key={key++}>{match[2]}</code>);
    else if (match[3] !== undefined || match[4] !== undefined) out.push(<strong key={key++}>{inline(match[3] ?? match[4])}</strong>);
    else if (match[5] !== undefined || match[6] !== undefined) out.push(<em key={key++}>{inline(match[5] ?? match[6])}</em>);
    else out.push(<Fragment key={key++}>{inline(match[7])} ({match[8]})</Fragment>);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(text: string[]): ReactNode[] {
  return text.flatMap((line, n) => (n ? [<br key={`br${n}`} />, ...inline(line)] : inline(line)));
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="sospio-md">
      {parseBlocks(text).map((block, n) => {
        switch (block.kind) {
          case "code": return <pre key={n}><code>{block.text}</code></pre>;
          case "heading": {
            const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
            return <Tag key={n}>{inline(block.text)}</Tag>;
          }
          case "rule": return <hr key={n} />;
          case "quote": return <blockquote key={n}>{lines(block.lines)}</blockquote>;
          case "list": {
            const items = block.items.map((item, k) => <li key={k}>{lines(item.split("\n"))}</li>);
            return block.ordered
              ? <ol key={n} start={block.start}>{items}</ol>
              : <ul key={n}>{items}</ul>;
          }
          case "table":
            return (
              <div key={n} className="sospio-md-table">
                <table>
                  <thead><tr>{block.header.map((cell, k) => <th key={k}>{inline(cell)}</th>)}</tr></thead>
                  <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          default: return <p key={n}>{lines(block.lines)}</p>;
        }
      })}
    </div>
  );
}
