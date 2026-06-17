/**
 * RSS parser tests.
 */

import { describe, it, expect } from "vitest";
import { parseRss } from "@/utils/rss";

const RSS_20_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <item>
      <title>Hello World</title>
      <link>https://example.com/hello</link>
      <pubDate>Mon, 15 Jun 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[<p>This is a test post.</p>]]></description>
      <category>AI</category>
      <category>ML</category>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <pubDate>Tue, 16 Jun 2026 00:00:00 GMT</pubDate>
      <description>Another test.</description>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom"/>
    <updated>2026-06-15T00:00:00Z</updated>
    <summary>Atom summary here.</summary>
    <category>Tech</category>
  </entry>
</feed>`;

describe("parseRss", () => {
  it("parses RSS 2.0 feed", () => {
    const items = parseRss(RSS_20_XML);
    expect(items.length).toBe(2);
    expect(items[0]!.title).toBe("Hello World");
    expect(items[0]!.link).toBe("https://example.com/hello");
    expect(items[0]!.description).toBe("This is a test post.");
    expect(items[0]!.categories).toEqual(["AI", "ML"]);
  });

  it("parses Atom feed", () => {
    const items = parseRss(ATOM_XML);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Atom Entry");
    expect(items[0]!.link).toBe("https://example.com/atom");
    expect(items[0]!.categories).toEqual(["Tech"]);
  });

  it("strips HTML from descriptions", () => {
    const items = parseRss(RSS_20_XML);
    expect(items[0]!.description).not.toContain("<p>");
  });

  it("parses dates to ISO format", () => {
    const items = parseRss(RSS_20_XML);
    expect(items[0]!.pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
