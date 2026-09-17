/**
 * Report Template
 * Small financial ack (cierre de caja, corte, arqueo). Same LayoutCalculator +
 * EscPosBuilder pattern as invoice-template; the POS sends precomputed totals.
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, ReportPayload } from '../types';
import { EscPosBuilder, EscPosUtils } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

export class ReportTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const data = payload as unknown as ReportPayload;
    const builder = EscPosBuilder.create(capabilities);
    const W = capabilities.maxWidth;
    const L = new LayoutCalculator(W);
    const money = (n: number) => EscPosUtils.formatCurrency(n, 2);

    const lv = (label: string, value: string) => {
      for (const ln of L.labelValue(label, value)) builder.line(ln);
    };

    // === HEADER (centered via hardware) ===
    if (data.header) {
      builder.align(1);
      if (data.header.storeName) {
        builder.fontSize(1).bold(true);
        builder.line(data.header.storeName);
        builder.fontSize(0).bold(false);
      }
      if (data.header.storeAddress) {
        for (const addr of data.header.storeAddress) {
          for (const ln of L.wordWrap(addr)) builder.line(ln);
        }
      }
      if (data.header.storePhone) builder.line(`Tel: ${data.header.storePhone}`);
      if (data.header.taxId) builder.line(`RNC: ${data.header.taxId}`);
      builder.newline();
    }

    // === TITLE ===
    builder.align(1);
    builder.bold(true);
    builder.line(data.title || 'REPORTE');
    builder.bold(false);
    builder.newline();

    // === META ===
    builder.align(0);
    builder.line(L.divider());
    lv('Reporte #', data.reportId);
    lv('Fecha', data.reportDate);
    if (data.reportTime) lv('Hora', data.reportTime);
    if (data.cashier) lv('Cajero', data.cashier);
    builder.line(L.divider());
    builder.newline();

    // === SECTIONS ===
    for (const s of data.sections) {
      builder.line(L.totalsRow(s.label + ':', money(s.amount)));
    }
    builder.line(L.divider());

    // === TOTAL ===
    builder.bold(true);
    builder.line(L.totalsRow('TOTAL:', money(data.total)));
    builder.bold(false);
    builder.line(L.divider());

    // === PAYMENTS (optional breakdown) ===
    if (data.payments?.length) {
      builder.newline();
      builder.bold(true);
      builder.line('Pagos:');
      builder.bold(false);
      for (const p of data.payments) {
        builder.line(L.totalsRow(`  ${p.label}:`, money(p.amount)));
      }
      builder.line(L.divider());
    }

    // === DIFFERENCE (only when non-zero) ===
    if (data.difference !== undefined && data.difference !== 0) {
      const label = data.difference > 0 ? 'Sobrante:' : 'Faltante:';
      builder.bold(true);
      builder.line(L.totalsRow(label, money(data.difference)));
      builder.bold(false);
      builder.line(L.divider());
    }

    // === NOTES ===
    if (data.notes) {
      builder.newline();
      for (const ln of L.wordWrap(data.notes)) builder.line(ln);
    }

    // === FOOTER ===
    builder.align(1);
    builder.newline();
    if (data.footer?.message) {
      for (const m of data.footer.message) {
        for (const ln of L.wordWrap(m)) builder.line(ln);
      }
    }
    if (data.footer?.thankYouMessage) builder.line(data.footer.thankYouMessage);
    builder.newline();

    builder.feedAndCut(4);
    return builder.build();
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<ReportPayload>;
    return !!(
      typeof data.reportId === 'string' && data.reportId.length > 0 &&
      typeof data.reportDate === 'string' && data.reportDate.length > 0 &&
      Array.isArray(data.sections) && data.sections.length > 0 &&
      data.sections.every((s) =>
        typeof (s as ReportPayload['sections'][number]).label === 'string' &&
        typeof (s as ReportPayload['sections'][number]).amount === 'number' &&
        Number.isFinite((s as ReportPayload['sections'][number]).amount)
      ) &&
      typeof data.total === 'number' && Number.isFinite(data.total)
    );
  }
}
