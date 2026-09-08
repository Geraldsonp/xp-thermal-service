/**
 * Label Template
 * A single machine-readable CODE128 barcode, printed by the printer configured
 * with the `label` role. Payload is minimal: { barcode: string }.
 *
 * The printer's ESC/POS barcode command (GS k 73) requires CODE128 data to
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

/** GS k 73 raw data caps at 255 bytes on this hardware. */
const MAX_ENCODED_LENGTH = 255;

// Width budget: reject barcodes the target printer cannot render BEFORE the
// job is sent, so it fails with a 400 instead of printing nothing and being
// marked COMPLETED by the spooler anyway.
// ponytail: fixed 12 dots/char and 11 modules/symbol is conservative estimate;
// per-model DPI table if throughput matters
const MODULE_WIDTH = 2;
const QUIET_DOTS = 20;
const DOTS_PER_CHAR = 12;

function printableDots(maxWidth: number): number {
  return maxWidth * DOTS_PER_CHAR;
}

function requiredDots(valueLength: number, moduleWidth: number): number {
  return (valueLength + 3) * 11 * moduleWidth + QUIET_DOTS;
}

// ESC/POS GS k 73 CODE128 data carries its own code-set
// selector: an explicit `{B` prefix selects code set B (printable ASCII), and
// a literal `{` in the payload is escaped by doubling it (`{{`) per the Epson
// spec — otherwise the printer would read it as the start of another selector.
// ponytail: only set B is needed (validate rejects non-printable-ASCII), so no
// {A/{C switching or char-set auto-detection.
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

    // Printer-specific width check: the generic validate() has no capabilities,
    // so a value that fits the 255-byte cap can still be physically too wide.
    const required = requiredDots(data.barcode.length, MODULE_WIDTH);
    const printable = printableDots(capabilities.maxWidth);
    if (required > printable) {
      throw new PrintServiceError(
        `Barcode too wide for ${capabilities.maxWidth}-char printer at width ${MODULE_WIDTH}: ` +
        `${data.barcode.length} characters needs ~${required} dots but printer has ` +
        `~${printable} printable dots. Use a shorter value or a wider printer/2D barcode.`,
        ErrorCodes.JOB_INVALID_PAYLOAD,
        400,
        {
          barcodeLength: data.barcode.length,
          requiredDots: required,
          printableDots: printable,
          maxWidth: capabilities.maxWidth,
          moduleWidth: MODULE_WIDTH
        }
      );
    }

    const builder = EscPosBuilder.create(capabilities);

    // Same barcode geometry the test page uses: 2-dot modules, hardware text
    // below so a human can verify what was encoded.
    // ponytail: center so the bars don't hug the left edge where feed is uneven on POS58
    builder.align(1);
    builder.barcode(encodeCode128B(data.barcode), {
      type: BarcodeType.CODE128,
      width: 2,
      height: 60,
      position: 'below'
    });
    builder.align(0);
    // One logical label per job: feed far enough that the gap sensor clears
    // the platen on 30 mm / 40×30 mm die-cut stock. Cut only when the target
    // printer actually has a cutter; otherwise feed-only (no cut) — gap stock,
    // not continuous receipt paper. The test page uses feedAndCut(4) because
    // it targets the receipt role.
    // ponytail: fixed 8 keeps the 58 mm roll calibrated; tune here if you
    // switch stock (measure one label height in dots / 8-dot lines).
    if (capabilities.supportsCut) {
      builder.feedAndCut(8);
    } else {
      builder.feed(8);
    }

    return builder.build();
  }

  // Payload-only: printable ASCII + 255-byte cap counted on the actual encoded
  // command data (the `{B` selector and `{{` brace escaping count toward it).
  // Physical width is checked in render(), which has the printer's
  // capabilities and is what turns a too-wide barcode into a synchronous 400.
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
