/**
 * Tests for the label template: payload validation and the CODE128 bytes it
 * produces. The POS addresses the label printer by role id (`label`) and sends
 * a single field, so the contract under test is small on purpose.
 */

import { LabelTemplate } from '../src/templates/label-template';
import { TemplateEngine } from '../src/templates/engine';
import {
  BarcodeType,
  ErrorCodes,
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

  it('rejects values that no longer fit the 255-byte data cap', () => {
    const longPlain = 'A'.repeat(256);
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

  it('prints one CODE128 barcode as raw data (auto Code128, like test template)', () => {
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    const expected = Buffer.from(barcodeCommand(BarcodeType.CODE128, 'ABC123'));

    expect(bytes.indexOf(Buffer.from([0x1d, 0x6b]))).toBeGreaterThanOrEqual(0);
    expect(bytes.includes(expected)).toBe(true);
  });

  it('sends braces literally (POS58 auto Code128, no Epson {B doubling)', () => {
    const bytes = template.render({ barcode: '{X}' }, capabilities);
    expect(bytes.includes(Buffer.from(barcodeCommand(BarcodeType.CODE128, '{X}')))).toBe(true);
  });

  it('shows the human-readable value below the bars', () => {
    // BARCODE_TEXT_POSITION = GS h? no: GS H <n> with n=2 meaning below.
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    expect(bytes.includes(Buffer.from([0x1d, 0x48, 0x02]))).toBe(true);
  });

  it('feeds the label off the platen', () => {
    const bytes = template.render({ barcode: 'ABC123' }, capabilities);
    // Label stock (gap/die-cut): one job = one ejected label. Receipt role
    // uses feedAndCut(4); label uses feed-only 8 so the gap clears the platen
    // — feed 4 left the label in the presenter and required 3 clicks.
    expect(bytes[bytes.length - 2]).toBe(0x64); // ESC d
    expect(bytes[bytes.length - 1]).toBe(8);
  });
});

describe('LabelTemplate.render width validation (printer-specific)', () => {
  const template = new LabelTemplate();
  // 32-char uppercase-hex production value (the POS barcode id length).
  const productionBarcode = '978E08FD39394E849C24AE2EDEC79C87';

  const renderError = (
    payload: Record<string, unknown>,
    caps: PrinterCapabilities
  ): PrintServiceError => {
    try {
      template.render(payload, caps);
    } catch (error) {
      return error as PrintServiceError;
    }
    throw new Error('expected template.render to throw');
  };

  it('renders 12-char barcode 123456789012 on 48-char and 32-char printers', () => {
    const payload = { barcode: '123456789012' };

    // (12+3)*11*2+20 = 350 dots: fits both 576 (48-char) and 384 (32-char).
    const on48 = template.render(payload, { ...capabilities, maxWidth: 48 });
    const on32 = template.render(payload, { ...capabilities, maxWidth: 32 });

    for (const bytes of [on48, on32]) {
      expect(bytes.indexOf(Buffer.from([0x1d, 0x6b]))).toBeGreaterThanOrEqual(0);
      expect(bytes.includes(Buffer.from(barcodeCommand(BarcodeType.CODE128, '123456789012')))).toBe(true);
    }
  });

  it('rejects 32-char production barcode 978E08FD39394E849C24AE2EDEC79C87 on 48-char printer', () => {
    const error = renderError({ barcode: productionBarcode }, { ...capabilities, maxWidth: 48 });

    expect(error).toBeInstanceOf(PrintServiceError);
    expect(error.code).toBe(ErrorCodes.JOB_INVALID_PAYLOAD);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/too wide/i);
    expect(error.message).toMatch(/shorter value|wider printer/i);
    // (32+3)*11*2+20 = 790 needed vs 48*12 = 576 printable.
    expect(error.details).toMatchObject({
      barcodeLength: 32,
      requiredDots: 790,
      printableDots: 576
    });
  });

  it('rejects 32-char on 32-char printer as well', () => {
    const error = renderError({ barcode: productionBarcode }, { ...capabilities, maxWidth: 32 });

    expect(error).toBeInstanceOf(PrintServiceError);
    expect(error.code).toBe(ErrorCodes.JOB_INVALID_PAYLOAD);
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({
      barcodeLength: 32,
      requiredDots: 790,
      printableDots: 384
    });
  });

  it('accepts 22-char on 48-char but rejects same on 32-char', () => {
    const value = 'A'.repeat(22);

    // (22+3)*11*2+20 = 570 <= 576: fits a 48-char printer, no throw.
    expect(() =>
      template.render({ barcode: value }, { ...capabilities, maxWidth: 48 })
    ).not.toThrow();

    // 570 > 384: the identical value is too wide on a 32-char printer.
    const error = renderError({ barcode: value }, { ...capabilities, maxWidth: 32 });
    expect(error).toBeInstanceOf(PrintServiceError);
    expect(error.code).toBe(ErrorCodes.JOB_INVALID_PAYLOAD);
    expect(error.statusCode).toBe(400);
  });

  it('validate still passes for 32-char (payload-only) but render rejects', () => {
    // validate() has no capabilities: ASCII + 255-byte cap only.
    expect(template.validate({ barcode: productionBarcode })).toBe(true);

    // Width is printer-specific and therefore enforced at render time.
    expect(() =>
      template.render({ barcode: productionBarcode }, { ...capabilities, maxWidth: 48 })
    ).toThrow(PrintServiceError);
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
