/**
 * Tests for the label template: payload validation and the CODE128 bytes it
 * produces. The POS addresses the label printer by role id (`label`) and sends
 * a single field, so the contract under test is small on purpose.
 */

import { LabelTemplate } from '../src/templates/label-template';
import { TemplateEngine } from '../src/templates/engine';
import {
  BarcodeType,
  PrintServiceError,
  PrinterCapabilities,
  TemplateType
} from '../src/types';

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

/** ESC/POS function A barcode header: GS k <type> <data bytes> NUL. */
const barcodeCommand = (type: number, data: string) => [
  0x1d, 0x6b, type,
  ...Buffer.from(data, 'ascii'),
  0x00
];

describe('LabelTemplate.validate', () => {
  const template = new LabelTemplate();

  it('accepts the uppercase hyphen-free UUID hex the POS generator sends', () => {
    expect(template.validate({ barcode: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' })).toBe(true);
  });

  it('accepts other printable Code128-B values', () => {
    expect(template.validate({ barcode: 'ORDER-0001' })).toBe(true);
    expect(template.validate({ barcode: 'abc 123' })).toBe(true);
  });

  it('rejects a missing, empty or non-string barcode', () => {
    expect(template.validate({})).toBe(false);
    expect(template.validate({ barcode: '' })).toBe(false);
    expect(template.validate({ barcode: 42 })).toBe(false);
    expect(template.validate(null as unknown as Record<string, unknown>)).toBe(false);
  });

  it('rejects values Code128 function A cannot carry', () => {
    // NUL would terminate the barcode data early on the printer.
    expect(template.validate({ barcode: 'A\x00B' })).toBe(false);
    // Non-ASCII has no code set B mapping.
    expect(template.validate({ barcode: 'étiquette' })).toBe(false);
  });

  it('rejects values that no longer fit the 255-byte function A data cap once encoded', () => {
    const longPlain = 'A'.repeat(255);
    expect(template.validate({ barcode: longPlain })).toBe(false);
  });
});

describe('LabelTemplate.render', () => {
  const template = new LabelTemplate();

  it('fails loudly instead of printing a blank label when the printer cannot do barcodes', () => {
    const noBarcode = { ...capabilities, supportsBarcode: false };

    // The payload is fine - the printer is wrong - so validate stays true and
    // the refusal happens at render, as a PrintServiceError, not a silent feed.
    expect(template.validate({ barcode: 'ABC123' })).toBe(true);
    expect(() => template.render({ barcode: 'ABC123' }, noBarcode)).toThrow(PrintServiceError);
    expect(() => template.render({ barcode: 'ABC123' }, noBarcode)).toThrow(/barcode support/);
  });

  it('prints one CODE128 barcode with the {B code-set selector required by function A', () => {
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    const expected = Buffer.from(barcodeCommand(BarcodeType.CODE128, '{BABC123'));

    expect(bytes.indexOf(Buffer.from([0x1d, 0x6b]))).toBeGreaterThanOrEqual(0);
    expect(bytes.includes(expected)).toBe(true);
  });

  it('doubles literal open braces per the Code128 spec', () => {
    const bytes = template.render({ barcode: '{X}' }, capabilities);
    expect(bytes.includes(Buffer.from(barcodeCommand(BarcodeType.CODE128, '{B{{X}')))).toBe(true);
  });

  it('shows the human-readable value below the bars', () => {
    // BARCODE_TEXT_POSITION = GS h? no: GS H <n> with n=2 meaning below.
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    expect(bytes.includes(Buffer.from([0x1d, 0x48, 0x02]))).toBe(true);
  });

  it('feeds the label off the platen', () => {
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    expect(bytes[bytes.length - 1]).toBe(1); // ESC d 1
  });
});

describe('TemplateEngine wiring', () => {
  it('accepts the label template type and validates through the engine', () => {
    const engine = new TemplateEngine();

    const bytes = engine.render(TemplateType.LABEL, { barcode: 'ABC123' }, capabilities);
    expect(bytes.length).toBeGreaterThan(0);

    expect(() =>
      engine.render(TemplateType.LABEL, { barcode: '' }, capabilities)
    ).toThrow(/Invalid payload/);
  });
});
