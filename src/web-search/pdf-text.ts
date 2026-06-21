import { inflateSync } from "node:zlib";

const MAX_PDF_TEXT_CHARS = 200_000;

/**
 * Best-effort, dependency-free PDF text extraction.
 *
 * It handles the common text operators used by digitally generated PDFs and
 * Flate-compressed content streams. Scanned/image-only PDFs intentionally
 * return an empty string; saving the original file still succeeds.
 */
export function extractPdfText(body: Uint8Array): string {
  const source = Buffer.from(body).toString("latin1");
  const streams = extractStreams(source);
  const parts = [source, ...streams]
    .flatMap((value) => extractTextOperators(value))
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(parts)].join("\n").slice(0, MAX_PDF_TEXT_CHARS);
}

function extractStreams(source: string): string[] {
  const streams: string[] = [];
  const pattern = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gi;
  for (const match of source.matchAll(pattern)) {
    const dictionary = match[1] ?? "";
    const raw = Buffer.from(match[2] ?? "", "latin1");
    if (/\/FlateDecode\b/.test(dictionary)) {
      try {
        streams.push(inflateSync(raw).toString("latin1"));
      } catch {
        // Corrupt or unsupported stream filters are skipped.
      }
    } else {
      streams.push(raw.toString("latin1"));
    }
  }
  return streams;
}

function extractTextOperators(source: string): string[] {
  const output: string[] = [];
  for (const block of source.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    const content = block[1] ?? "";
    for (const text of content.matchAll(/\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")/g)) {
      output.push(decodePdfLiteral(text[0]!.replace(/\)\s*(?:Tj|'|")$/, ")")));
    }
    for (const array of content.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
      for (const text of (array[1] ?? "").matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        output.push(decodePdfLiteral(text[0]!));
      }
    }
  }
  return output;
}

function decodePdfLiteral(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
      const map: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };
      return map[escaped] ?? escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
    .replace(/\\\r?\n/g, "");
}
