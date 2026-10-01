import { readFile } from "node:fs/promises";
import { getDocumentProxy } from "unpdf";
import { itemsToLines, parseSections, type TextItem } from "./layout";
import type { PdfLine, Section } from "./types";

/** Read every page of the PDF as visual lines (with position and font size). */
export async function readPdfLines(pdfPath: string): Promise<{ lines: PdfLine[]; pageCount: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(pdfPath)));
  const lines: PdfLine[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    // Marked-content items carry no text; keep only real text items.
    const textItems = items.filter((it): it is TextItem & typeof it => "str" in it);
    lines.push(...itemsToLines(textItems, n));
  }
  return { lines, pageCount: pdf.numPages };
}

export async function readSections(pdfPath: string): Promise<{ sections: Section[]; pageCount: number }> {
  const { lines, pageCount } = await readPdfLines(pdfPath);
  return { sections: parseSections(lines), pageCount };
}
