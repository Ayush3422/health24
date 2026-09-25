import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  formatPaise,
  LEDGER_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  type Invoice,
} from '@health24/shared';
import { istDateTime, Sheet } from '../exports/pdf-sheet';

/**
 * Money as this PDF can print it.
 *
 * The standard PDF fonts are WinAnsi and have no rupee sign, and embedding a
 * font that does would mean shipping one. "Rs" is what every printed bill in
 * India said before the sign existed, and it prints anywhere; the screens keep
 * the ₹.
 */
const money = (paise: number): string => formatPaise(paise).replace('₹', 'Rs ');

/**
 * The invoice as the patient carries it away (sp6-plan.md, DF8).
 *
 * Itemised, with what has been paid against it and what is still owed. It says
 * what the ledger says, because it is made from the ledger.
 */
export async function buildInvoicePdf(invoice: Invoice, hospitalName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`Invoice ${invoice.number}`);
  doc.setCreator('Health24');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = new Sheet(doc, font, bold);

  sheet.title(`Invoice ${invoice.number}`);
  sheet.line(hospitalName, { bold: true });
  sheet.line(
    [invoice.patientName, invoice.mrn ? `Hospital number ${invoice.mrn}` : null]
      .filter(Boolean)
      .join(' · '),
  );
  sheet.line(`Issued ${istDateTime.format(new Date(invoice.issuedAt))}`, { muted: true });
  if (invoice.note) sheet.line(invoice.note);

  sheet.heading('Items');
  for (const line of invoice.lines) {
    sheet.entry(`${line.description} — ${money(line.amountPaise)}`, [
      `${line.code} · ${line.quantity} × ${money(line.unitPricePaise)}`,
    ]);
  }

  sheet.heading('Total');
  sheet.line(money(invoice.totalPaise), { bold: true });

  if (invoice.ledger.length > 0) {
    sheet.heading('Paid and credited');
    for (const entry of invoice.ledger) {
      sheet.line(
        [
          LEDGER_KIND_LABELS[entry.kind],
          money(entry.amountPaise),
          entry.method ? PAYMENT_METHOD_LABELS[entry.method] : null,
          entry.reference,
          istDateTime.format(new Date(entry.at)),
        ]
          .filter(Boolean)
          .join(' · '),
      );
    }
  }

  sheet.heading(invoice.outstandingPaise > 0 ? 'Still to pay' : 'Nothing outstanding');
  sheet.line(money(Math.max(0, invoice.outstandingPaise)), { bold: true });

  sheet.footer(`Invoice ${invoice.number} · ${invoice.patientName} · ${hospitalName}`);

  return doc.save();
}
