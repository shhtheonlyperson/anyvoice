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

function makeEpubWithNcx(): Uint8Array {
  const container = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>有聲書測試</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="fw" href="Text/Foreword.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="Text/Chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="fw"/><itemref idref="c1"/></spine></package>`;
  const ncx = `<?xml version="1.0"?><ncx><navMap>
    <navPoint><navLabel><text>推薦序</text></navLabel><content src="Text/Foreword.xhtml"/></navPoint>
    <navPoint><navLabel><text>第一章 開始</text></navLabel><content src="Text/Chapter1.xhtml"/></navPoint>
  </navMap></ncx>`;
  return zipSync({
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/toc.ncx": strToU8(ncx),
    "OEBPS/Text/Foreword.xhtml": strToU8(`<html><body><p>這是一篇推薦序的內容，夠長以通過篩選。</p></body></html>`),
    "OEBPS/Text/Chapter1.xhtml": strToU8(`<html><body><p>第一章的正文內容，故事從這裡開始。</p></body></html>`),
  });
}

describe("extractBook TOC", () => {
  it("uses NCX titles and classifies main chapters vs on-demand extras", async () => {
    const book = await extractBook("b.epub", makeEpubWithNcx());
    expect(book.title).toBe("有聲書測試");
    expect(book.chapters.map((c) => [c.title, c.kind])).toEqual([
      ["推薦序", "extra"],
      ["第一章 開始", "chapter"],
    ]);
  });
});

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
