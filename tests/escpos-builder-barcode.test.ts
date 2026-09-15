/**
 * Focused tests for EscPosBuilder.barcode command framing. ESC/POS GS k has
 * two forms: legacy function A (m < 65) is NUL-terminated, function B
 * (m >= 65) carries a one-byte length and no terminator. Code128 (m=73) is
 * function B — the length-prefixed framing is what makes its data unambiguous.
 */

import { EscPosBuilder, NUL } from '../src/escpos/builder';
import { BarcodeType } from '../src/types';

const GS = 0x1d;
const K = 0x6b;

const render = (data: string, type: number): Buffer =>
  new EscPosBuilder({ supportsBarcode: true })
    .barcode(data, { type: type as BarcodeType })
    .build();

/** Everything from the GS k print command onward (barcode is emitted last). */
const printCommand = (bytes: Buffer): Buffer =>
  bytes.subarray(bytes.indexOf(Buffer.from([GS, K])));

describe('EscPosBuilder.barcode framing', () => {
  it('emits function B (GS k 73 n <data>) for Code128 with no NUL terminator', () => {
    const bytes = render('ABC123', BarcodeType.CODE128);

    expect(printCommand(bytes)).toEqual(
      Buffer.from([GS, K, BarcodeType.CODE128, 6, ...Buffer.from('ABC123', 'ascii')])
    );
    // The length prefix replaces the NUL terminator.
    expect(printCommand(bytes).includes(NUL)).toBe(false);
  });

  it('still emits legacy function A (GS k m <data> NUL) for types below 65', () => {
    // m=4 is CODE39 in the legacy function-A numbering.
    const bytes = render('ABC123', 4);

    expect(printCommand(bytes)).toEqual(
      Buffer.from([GS, K, 4, ...Buffer.from('ABC123', 'ascii'), NUL])
    );
  });

  it('accepts exactly 255 bytes for the one-byte length form', () => {
    const bytes = render('A'.repeat(255), BarcodeType.CODE128);
    const cmd = printCommand(bytes);

    expect(cmd[0]).toBe(GS);
    expect(cmd[1]).toBe(K);
    expect(cmd[2]).toBe(BarcodeType.CODE128);
    expect(cmd[3]).toBe(255);
    expect(cmd.length).toBe(4 + 255); // header + data, no NUL
  });

  it('throws when data exceeds the 255-byte one-byte length cap', () => {
    expect(() => render('A'.repeat(256), BarcodeType.CODE128)).toThrow(/255/);
  });
});
