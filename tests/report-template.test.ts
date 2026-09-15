/**
 * Tests for the report template: payload validation and the ESC/POS bytes it
 * produces. Small financial ack (cierre de caja, corte, arqueo).
 */

import { ReportTemplate } from '../src/templates/report-template';
import { TemplateEngine } from '../src/templates/engine';
import { PrinterCapabilities, TemplateType } from '../src/types';

const capabilities: PrinterCapabilities = {
  maxWidth: 48,
  supportsBold: true,
  supportsUnderline: true,
  supportsBarcode: true,
  supportsQRCode: true,
  supportsImage: true,
  supportsCut: true,
  supportsPartialCut: false,
  supportsCashDrawer: false,
  supportsDensity: true,
  codepage: 0
};

const valid = {
  reportId: 'C-001',
  title: 'CIERRE DE CAJA',
  reportDate: '2026-09-15',
  reportTime: '18:00',
  cashier: 'Ana',
  sections: [
    { label: 'Efectivo', amount: 100 },
    { label: 'Tarjeta', amount: 50.5 }
  ],
  total: 150.5
};

describe('ReportTemplate.validate', () => {
  const template = new ReportTemplate();

  it('accepts a minimal valid payload', () => {
    expect(template.validate(valid)).toBe(true);
  });

  it('rejects missing id, date, sections or total', () => {
    expect(template.validate({})).toBe(false);
    expect(template.validate({ ...valid, reportId: '' })).toBe(false);
    expect(template.validate({ ...valid, reportDate: '' })).toBe(false);
    expect(template.validate({ ...valid, sections: [] })).toBe(false);
    expect(template.validate({ ...valid, total: 'x' })).toBe(false);
  });

  it('rejects sections with bad label/amount', () => {
    expect(template.validate({ ...valid, sections: [{ label: 'X', amount: NaN }] })).toBe(false);
    expect(template.validate({ ...valid, sections: [{ label: 1, amount: 2 }] })).toBe(false);
  });
});

describe('ReportTemplate.render', () => {
  const template = new ReportTemplate();

  it('prints title, sections and total then feeds and cuts', () => {
    const bytes = template.render(valid, capabilities);
    expect(bytes.includes(Buffer.from('CIERRE DE CAJA'))).toBe(true);
    expect(bytes.includes(Buffer.from('TOTAL:'))).toBe(true);
    expect(bytes.includes(Buffer.from('150.50'))).toBe(true);
    // ESC d 4 + GS V 0 = feedAndCut(4)
    expect(bytes.subarray(bytes.length - 6)).toEqual(Buffer.from([0x1b, 0x64, 4, 0x1d, 0x56, 0x00]));
  });

  it('renders on 32-char paper without throwing', () => {
    expect(() => template.render(valid, { ...capabilities, maxWidth: 32 })).not.toThrow();
  });

  it('prints payments breakdown when present', () => {
    const bytes = template.render(
      { ...valid, payments: [{ label: 'Efectivo', amount: 100 }] },
      capabilities
    );
    expect(bytes.includes(Buffer.from('Pagos:'))).toBe(true);
  });

  it('omits difference when zero, prints it otherwise', () => {
    const zero = template.render({ ...valid, difference: 0 }, capabilities);
    expect(zero.includes(Buffer.from('Sobrante:'))).toBe(false);
    expect(zero.includes(Buffer.from('Faltante:'))).toBe(false);

    const over = template.render({ ...valid, difference: 5 }, capabilities);
    expect(over.includes(Buffer.from('Sobrante:'))).toBe(true);

    const short = template.render({ ...valid, difference: -3 }, capabilities);
    expect(short.includes(Buffer.from('Faltante:'))).toBe(true);
  });

  it('defaults title to REPORTE when omitted', () => {
    const { title: _omit, ...noTitle } = valid;
    const bytes = template.render(noTitle, capabilities);
    expect(bytes.includes(Buffer.from('REPORTE'))).toBe(true);
  });
});

describe('TemplateEngine wiring', () => {
  it('renders report through the engine and rejects bad payload', () => {
    const engine = new TemplateEngine();
    expect(engine.render(TemplateType.REPORT, valid, capabilities).length).toBeGreaterThan(0);
    expect(() => engine.render(TemplateType.REPORT, { reportId: '' }, capabilities)).toThrow(
      /Invalid payload/
    );
  });
});
