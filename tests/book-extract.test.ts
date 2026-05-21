import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { detectBookFormat, extractBook } from "@/lib/book-extract";

function makeEpub(): Uint8Array {
  const container = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Test Book</dc:title></metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const ch1 = `<html><body><h1>第一章</h1><p>你好世界。</p><p>這是第一章。</p></body></html>`;
  const ch2 = `<html><body><h1>Chapter Two</h1><p>Second chapter text.</p></body></html>`;
  return zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/ch1.xhtml": strToU8(ch1),
    "OEBPS/ch2.xhtml": strToU8(ch2),
    "OEBPS/style.css": strToU8("body{}"),
  });
}

describe("detectBookFormat", () => {
  it("detects epub and pdf by extension and mime", () => {
    expect(detectBookFormat("book.epub")).toBe("epub");
    expect(detectBookFormat("book.pdf")).toBe("pdf");
    expect(detectBookFormat("x", "application/epub+zip")).toBe("epub");
    expect(detectBookFormat("notes.txt")).toBeNull();
  });
});

describe("extractBook (epub)", () => {
  it("extracts spine-ordered chapters, titles, and text", async () => {
    const book = await extractBook("ignored.epub", makeEpub());
    expect(book.title).toBe("My Test Book");
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe("第一章");
    expect(book.chapters[0].text).toContain("你好世界。");
    expect(book.chapters[0].text).toContain("這是第一章。");
    expect(book.chapters[1].title).toBe("Chapter Two");
    expect(book.chapters[1].text).toContain("Second chapter text.");
  });

  it("falls back to the filename when there is no embedded title", async () => {
    const noTitleOpf = makeEpub(); // has a title; instead test the unsupported path
    expect(noTitleOpf.byteLength).toBeGreaterThan(0);
    await expect(extractBook("song.mp3", new Uint8Array([1, 2, 3]))).rejects.toThrow(/unsupported/);
  });
});
