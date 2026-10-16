import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { safeFetch, FetchError } from "./safefetch.js";
import { checkRobots } from "./robots.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 200;

export function looksLikePdf(buf: Uint8Array) {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

/** Extract the embedded text layer per page with PDF.js. No OCR, no script execution. */
export async function pdfToText(buf: Uint8Array) {
  if (!looksLikePdf(buf)) throw new FetchError("not_a_pdf", "Input is not a PDF (missing %PDF header)", 415);
  let pdf;
  try {
    pdf = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (e) {
    const name = (e as Error).name ?? ""; const msg = (e as Error).message ?? "";
    if (name === "PasswordException" || /password/i.test(msg)) throw new FetchError("encrypted_pdf", "Encrypted PDFs are not supported", 422);
    throw new FetchError("corrupt_pdf", "Could not parse PDF", 422);
  }
  try {
    if (pdf.numPages > MAX_PAGES) throw new FetchError("too_many_pages", `PDF has ${pdf.numPages} pages; limit is ${MAX_PAGES}`, 413);
    const content: { page: number; text: string; chars: number }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let text = "";
      for (const it of tc.items as any[]) { if (typeof it.str === "string") text += it.str + (it.hasEOL ? "\n" : ""); }
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      content.push({ page: i, text, chars: text.length });
      page.cleanup();
    }
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    return {
      pages: pdf.numPages,
      title: typeof info.Title === "string" && info.Title ? info.Title : null,
      author: typeof info.Author === "string" && info.Author ? info.Author : null,
      text_layer_empty_pages: content.filter((p) => p.chars === 0).map((p) => p.page),
      content,
    };
  } finally {
    await pdf.destroy();
  }
}

export async function pdfFromUrl(u: URL) {
  const robots = await checkRobots(u);
  if (!robots.allowed) throw new FetchError("robots_disallowed", `robots.txt disallows assay-fetch for this path (${robots.rule})`, 451);
  const r = await safeFetch(u, { maxBytes: MAX_PDF_BYTES, accept: "application/pdf", timeoutMs: 20_000 });
  if (r.status >= 400) throw new FetchError("upstream_status", `Upstream returned HTTP ${r.status}`, 502);
  return { buf: new Uint8Array(r.body), source_url: r.finalUrl, robots };
}
