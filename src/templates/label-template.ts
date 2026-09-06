/**
 * Label Template
 * A single machine-readable CODE128 barcode, printed by the printer configured
 * with the `label` role. Payload is minimal: { barcode: string }.
 *
 * The printer's ESC/POS function A (GS k 73 ... NUL) requires CODE128 data to
 * carry its own code-set selector, so the value is encoded with a `{B` prefix
 * (code set B: printable ASCII) and literal braces doubled per spec.
 */

import { TemplateRenderer } from './engine';
import {
  BarcodeType,
  ErrorCodes,
  LabelPayload,
  PrintServiceError,
  PrinterCapabilities
} from '../types';
import { EscPosBuilder } from '../escpos/builder';

/** GS k function A caps data at 255 bytes; `{B` plus worst-case `{`→`{{`. */
const MAX_ENCODED_LENGTH = 255;

function encodeCode128B(value: string): string {
  return '{B' + value.replace(/\{/g, '{{');
}

export class LabelTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    // A silent no-op here would feed a blank label and report success. Unlike
    // most templates, a label IS its barcode, so refuse loudly instead.
    if (!capabilities.supportsBarcode) {
      throw new PrintServiceError(
        'Label template requires a printer with barcode support (supportsBarcode: false)',
        ErrorCodes.PRINTER_ERROR
      );
    }

    const data = payload as unknown as LabelPayload;
    const builder = EscPosBuilder.create(capabilities);

    // Same barcode geometry the test page uses: 2-dot modules, hardware text
    // below so a human can verify what was encoded.
    builder.barcode(encodeCode128B(data.barcode), {
      type: BarcodeType.CODE128,
      width: 2,
      height: 60,
      position: 'below'
    });
    builder.feed(1);

    return builder.build();
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<LabelPayload>;
    const value = data?.barcode;
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
    // Code set B covers printable ASCII; NUL would also terminate the barcode
    // data early on function A, so anything outside 0x20-0x7E is rejected.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) {
        return false;
      }
    }
    return encodeCode128B(value).length <= MAX_ENCODED_LENGTH;
  }
}
