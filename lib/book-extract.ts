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

  // 2. parse OPF manifest (id→href) + spine order
  const opfRoot = parse(opf);
  const manifest = new Map<string, string>();
  for (const item of opfRoot.querySelectorAll("item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, href);
  }
  // dc:title via regex (CSS selectors don't handle the namespaced tag reliably).
  const bookTitle = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim();

  // 3. walk the spine, extract each document as a chapter
  const chapters: BookChapterInput[] = [];
  for (const ref of opfRoot.querySelectorAll("itemref")) {
    const idref = ref.getAttribute("idref");
    const href = idref ? manifest.get(idref) : undefined;
    if (!href) continue;
    const doc = get(resolveHref(opfDir, href));
    if (!doc) continue;
    const { title, text } = xhtmlToText(doc);
    if (text) chapters.push({ title, text });
  }
  if (chapters.length === 0) throw new Error("EPUB contained no readable text");

  return { title: bookTitle || "Untitled", chapters };
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
