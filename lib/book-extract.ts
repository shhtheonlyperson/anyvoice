import { unzipSync } from "fflate";
import { parse } from "node-html-parser";
import { extractText, getDocumentProxy } from "unpdf";
import type { BookChapterInput } from "@/lib/book-segment";

export interface ExtractedBook {
  title: string;
  chapters: BookChapterInput[];
}

export type BookFormat = "epub" | "pdf";

export function detectBookFormat(filename: string, mime?: string): BookFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".epub") || mime === "application/epub+zip") return "epub";
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  return null;
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

const decoder = new TextDecoder("utf-8");

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function resolveHref(base: string, href: string): string {
  const cleaned = href.split("#")[0];
  if (!base) return cleaned;
  const parts = `${base}/${cleaned}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function xhtmlToText(xhtml: string): { title: string; text: string } {
  const root = parse(xhtml, { blockTextElements: { script: false, style: false } });
  root.querySelectorAll("script,style").forEach((n) => n.remove());
  const heading = root.querySelector("h1,h2,h3,title");
  const body = root.querySelector("body") ?? root;
  return {
    title: (heading?.text ?? "").trim(),
    // structuredText keeps block-level line breaks, preserving paragraphs.
    text: body.structuredText.replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function extractEpub(buffer: Uint8Array): ExtractedBook {
  const files = unzipSync(buffer);
  const get = (p: string): string | null => (files[p] ? decoder.decode(files[p]) : null);

  // 1. container.xml → OPF path
  const container = get("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error("invalid EPUB: missing OPF rootfile");
  const opf = get(opfPath);
  if (!opf) throw new Error("invalid EPUB: OPF not found");
  const opfDir = dirname(opfPath);

  // 2. parse OPF manifest (id→href, id→media-type, properties)
  const opfRoot = parse(opf);
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of opfRoot.querySelectorAll("item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) {
      manifest.set(id, {
        href,
        mediaType: item.getAttribute("media-type") || "",
        properties: item.getAttribute("properties") || "",
      });
    }
  }
  const bookTitle = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim();

  // 3. Prefer the Table of Contents (NCX / EPUB3 nav) for chapter structure +
  //    real titles; fall back to spine order if no usable TOC.
  // readToc returns fully-resolved zip paths; the spine fallback resolves here.
  const tocEntries = readToc(opfRoot, manifest, opfPath, get);
  const sourceHrefs: { title: string; href: string }[] =
    tocEntries.length > 0
      ? tocEntries
      : [...opfRoot.querySelectorAll("itemref")]
          .map((ref) => manifest.get(ref.getAttribute("idref") || "")?.href)
          .filter((h): h is string => Boolean(h))
          .map((href) => ({ title: "", href: resolveHref(opfDir, href) }));

  const chapters: BookChapterInput[] = [];
  const seen = new Set<string>();
  for (const entry of sourceHrefs) {
    const file = entry.href.split("#")[0];
    if (seen.has(file)) continue; // collapse multiple TOC anchors in one file
    seen.add(file);
    const doc = get(file);
    if (!doc) continue;
    const { title, text } = xhtmlToText(doc);
    if (text.length < 8) continue; // skip cover / image-only / near-empty pages
    chapters.push({ title: entry.title || title, text, kind: classifyChapter(entry.title || title) });
  }
  if (chapters.length === 0) throw new Error("EPUB contained no readable text");

  return { title: bookTitle || "Untitled", chapters };
}

// Read ordered TOC entries (label + href) from NCX or EPUB3 nav, if present.
function readToc(
  opfRoot: ReturnType<typeof parse>,
  manifest: Map<string, { href: string; mediaType: string; properties: string }>,
  opfPath: string,
  get: (p: string) => string | null,
): { title: string; href: string }[] {
  const opfDir = dirname(opfPath);
  // NCX (EPUB2): spine toc="<id>" or a manifest item with the dtbncx media-type.
  const spine = opfRoot.querySelector("spine");
  const ncxId = spine?.getAttribute("toc");
  let ncxHref = ncxId ? manifest.get(ncxId)?.href : undefined;
  if (!ncxHref) {
    for (const [, item] of manifest) {
      if (item.mediaType === "application/x-dtbncx+xml") {
        ncxHref = item.href;
        break;
      }
    }
  }
  if (ncxHref) {
    const ncx = get(resolveHref(opfDir, ncxHref));
    if (ncx) {
      const ncxDir = dirname(resolveHref(opfDir, ncxHref));
      const entries: { title: string; href: string }[] = [];
      const re = /<navPoint[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ncx))) {
        const title = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        entries.push({ title, href: resolveHref(ncxDir, m[2]) });
      }
      if (entries.length > 0) return entries;
    }
  }
  // EPUB3 nav (properties="nav").
  for (const [, item] of manifest) {
    if (!item.properties.includes("nav")) continue;
    const nav = get(resolveHref(opfDir, item.href));
    if (!nav) break;
    const navDir = dirname(resolveHref(opfDir, item.href));
    const root = parse(nav);
    const tocNav = root.querySelector('nav[*|type="toc"], nav#toc, nav');
    const entries: { title: string; href: string }[] = [];
    for (const a of (tocNav ?? root).querySelectorAll("a")) {
      const href = a.getAttribute("href");
      const title = a.text.replace(/\s+/g, " ").trim();
      if (href && title) entries.push({ title, href: resolveHref(navDir, href) });
    }
    if (entries.length > 0) return entries;
  }
  return [];
}

// Main chapters auto-synthesize in order; everything else (foreword, reviews,
// afterword, cover) is an "extra" synthesized on demand.
function classifyChapter(title: string): "chapter" | "extra" {
  const t = title.trim();
  if (/第\s*[0-9〇零一二三四五六七八九十百千两兩]+\s*[章回卷篇折部]/.test(t)) return "chapter";
  if (/\bchapter\s+\d+/i.test(t) || /\bpart\s+\d+/i.test(t)) return "chapter";
  if (/^\s*\d+\s*[.、:：]/.test(t)) return "chapter";
  return "extra";
}

async function extractPdf(buffer: Uint8Array): Promise<ExtractedBook> {
  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: true });
  const cleaned = (Array.isArray(text) ? text.join("\n") : text).trim();
  if (!cleaned) throw new Error("PDF contained no extractable text (it may be scanned images)");
  // PDFs lack reliable chapter structure; treat as a single chapter and let
  // segmentation handle sentences. Paragraph breaks are preserved from the text.
  return { title: "Untitled", chapters: [{ title: "", text: cleaned }] };
}

export async function extractBook(
  filename: string,
  buffer: Uint8Array,
  mime?: string,
): Promise<ExtractedBook> {
  const format = detectBookFormat(filename, mime);
  if (!format) throw new Error("unsupported file: upload an .epub or .pdf");
  const book = format === "epub" ? extractEpub(buffer) : await extractPdf(buffer);
  // Prefer an embedded title; fall back to the filename.
  return { ...book, title: book.title !== "Untitled" ? book.title : titleFromFilename(filename) };
}
