import { rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * A4 pages of running text, wrapped to the page width.
 *
 * Shared by the patient's own copy of their record (SP5) and the discharge
 * summary (SP6): both are a hospital document read on paper as often as on a
 * screen, and neither is worth a second layout engine.
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const BODY_SIZE = 10;
const LINE = 14;
const INK = rgb(0.09, 0.13, 0.16);
const MUTED = rgb(0.31, 0.36, 0.4);

export const istDate = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export const istDateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const day = (value: string | null) =>
  value
    ? istDate.format(
        new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+05:30` : value),
      )
    : '—';

export const moment = (value: string | null) => (value ? istDateTime.format(new Date(value)) : '—');

export const join = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');

/** Lays out running text on A4 pages, wrapping to the page width. */
export class Sheet {
  private page: PDFPage;
  private y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN;
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(page);
    return page;
  }

  private room(needed = LINE): void {
    if (this.y - needed < MARGIN + 24) {
      this.page = this.newPage();
      this.y = PAGE.height - MARGIN;
    }
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];

    for (const paragraph of text.split('\n')) {
      let current = '';

      for (const word of paragraph.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > width && current) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }

      lines.push(current);
    }

    return lines;
  }

  title(text: string): void {
    this.room(30);
    this.page.drawText(text, { x: MARGIN, y: this.y - 18, size: 18, font: this.bold, color: INK });
    this.y -= 34;
  }

  heading(text: string): void {
    this.room(28);
    this.y -= 10;
    this.page.drawText(text, { x: MARGIN, y: this.y - 12, size: 13, font: this.bold, color: INK });
    this.y -= 24;
  }

  entry(heading: string, details: string[]): void {
    this.line(heading, { bold: true });
    for (const detail of details) {
      if (detail) this.line(detail, { indent: 12, muted: true });
    }
    this.y -= 4;
  }

  line(text: string, options: { bold?: boolean; muted?: boolean; indent?: number } = {}): void {
    const font = options.bold ? this.bold : this.font;
    const indent = options.indent ?? 0;
    const width = PAGE.width - 2 * MARGIN - indent;

    for (const wrapped of this.wrap(text, font, BODY_SIZE, width)) {
      this.room();
      this.page.drawText(wrapped, {
        x: MARGIN + indent,
        y: this.y - BODY_SIZE,
        size: BODY_SIZE,
        font,
        color: options.muted ? MUTED : INK,
      });
      this.y -= LINE;
    }
  }

  /** Page numbers and the note that this is a copy, on every page. */
  footer(text: string): void {
    this.pages.forEach((page, index) => {
      page.drawText(`${text} · Page ${index + 1} of ${this.pages.length}`, {
        x: MARGIN,
        y: MARGIN - 16,
        size: 8,
        font: this.font,
        color: MUTED,
      });
    });
  }
}
