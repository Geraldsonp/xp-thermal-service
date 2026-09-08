/**
 * Tests for the barcode section of the test page: the original raw Code128
 * barcode must stay byte-identical, and the second, explicitly Code128-B
 * barcode must carry the `{B` code-set selector so it scans as CODE128-B-TEST.
 */

import { TestTemplate } from '../src/templates/test-template';
import { BarcodeType, PrinterCapabilities } from '../src/types';

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

/** ESC/POS function B barcode: GS k <type> <n> <data bytes>, n = data length. */
const barcodeCommand = (type: number, data: string) => {
  const payload = Buffer.from(data, 'ascii');
  return [0x1d, 0x6b, type, payload.length, ...payload];
};

describe('TestTemplate barcodes', () => {
  const template = new TestTemplate();

  it('keeps the original raw Code128 barcode 123456789012 unchanged', () => {
    const bytes = template.render({ includeBarcode: true }, capabilities);
    expect(bytes.includes(Buffer.from(barcodeCommand(BarcodeType.CODE128, '123456789012')))).toBe(true);
  });

  it('prints the Code128-B Test barcode with an explicit {B code-set selector', () => {
    const bytes = template.render({ includeBarcode: true }, capabilities);
    // Scans/human-reads as CODE128-B-TEST; `{B` explicitly selects code set B.
    expect(bytes.includes(Buffer.from(barcodeCommand(BarcodeType.CODE128, '{BCODE128-B-TEST')))).toBe(true);
    expect(bytes.includes(Buffer.from('Code128-B Test:', 'ascii'))).toBe(true);
  });
});
