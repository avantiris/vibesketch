// PDF -> SVG in the browser with MuPDF (WebAssembly, ~10 MB, AGPL). Kept in its own module so
// it is only downloaded when a PDF is actually imported.

const MAX_PAGES = 50;

/** One SVG document per page (at most 50). Text comes out as glyph outlines, so it looks right
 *  without the PDF's fonts. Throws with a readable message for broken / encrypted files. */
export async function pdfToSvg(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await import('mupdf');
  let doc;
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  } catch (e) {
    throw new Error(`This PDF could not be read (${e instanceof Error ? e.message : e})`);
  }
  try {
    if (doc.needsPassword()) throw new Error('This PDF is password protected');
    const pages: string[] = [];
    const count = Math.min(doc.countPages(), MAX_PAGES);
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const buf = new mupdf.Buffer();
      const writer = new mupdf.DocumentWriter(buf, 'svg', 'text=path');
      try {
        const dev = writer.beginPage(page.getBounds());
        page.run(dev, mupdf.Matrix.identity);
        dev.close();
        writer.endPage();
        writer.close();
        pages.push(buf.asString());
      } finally {
        writer.destroy();
        buf.destroy();
        page.destroy();
      }
    }
    return pages;
  } finally {
    doc.destroy();
  }
}
