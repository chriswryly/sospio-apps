import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, parseBlocks } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("assistant markdown", () => {
  it("formats inline emphasis and code", () => {
    expect(html("A **bold** and *soft* word with `x = 1`.")).toBe(
      '<div class="sospio-md"><p>A <strong>bold</strong> and <em>soft</em> word with <code>x = 1</code>.</p></div>');
  });

  it("formats headings, lists, quotes, rules and code blocks", () => {
    const out = html("# Plan\n\n1. First\n2. Second **step**\n\n- one\n- two\n\n> quoted\n\n---\n\n```js\nlet a = '<b>';\n```");
    expect(out).toContain("<h3>Plan</h3>");
    expect(out).toContain('<ol start="1"><li>First</li><li>Second <strong>step</strong></li></ol>');
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<blockquote>quoted</blockquote>");
    expect(out).toContain("<hr/>");
    expect(out).toContain("<pre><code>let a = &#x27;&lt;b&gt;&#x27;;</code></pre>");
  });

  it("formats a table", () => {
    const out = html("| Venue | Seats |\n|---|---:|\n| Hall | **80** |");
    expect(out).toContain("<th>Venue</th><th>Seats</th>");
    expect(out).toContain("<td>Hall</td><td><strong>80</strong></td>");
  });

  it("never emits the model's HTML or a clickable link", () => {
    const out = html('<img src=x onerror="alert(1)"> **<script>alert(2)</script>** [site](javascript:alert(3))');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<a");
    expect(out).toContain("&lt;img");
    expect(out).toContain("site (javascript:alert(3))");
  });

  it("keeps line breaks inside a paragraph and leaves an unclosed fence open while streaming", () => {
    expect(html("line one\nline two")).toContain("<p>line one<br/>line two</p>");
    expect(parseBlocks("Here:\n```\npartial")).toEqual([
      { kind: "paragraph", lines: ["Here:"] }, { kind: "code", text: "partial" }]);
  });

  it("leaves unmatched markers as literal text", () => {
    expect(html("2 * 3 = 6 and snake_case_name")).toBe('<div class="sospio-md"><p>2 * 3 = 6 and snake_case_name</p></div>');
  });
});
