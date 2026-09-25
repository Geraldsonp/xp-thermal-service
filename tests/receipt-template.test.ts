import { ReceiptTemplate } from '../src/templates/receipt-template';
import { PrinterCapabilities, ReceiptPayload } from '../src/types';

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
  codepage: 0,
};

const payload: ReceiptPayload = {
  orderNumber: '000123',
  ncf: 'B0200000004',
  orderDate: '2026-09-25',
  items: [{ name: 'Item', quantity: 1, price: 100, total: 100 }],
  subtotal: 100,
  total: 100,
};

describe('ReceiptTemplate fiscal document number', () => {
  const template = new ReceiptTemplate();

  it('prints the NCF/ECF separately from the order number', () => {
    const output = template.render(payload as unknown as Record<string, unknown>, capabilities).toString('latin1');

    expect(output).toContain('Orden');
    expect(output).toContain('000123');
    expect(output).toContain('NCF/ECF');
    expect(output).toContain('B0200000004');
    expect(output).toContain('Orden:');
    expect(output).toContain('Orden: 000123');
    expect(output.indexOf('Orden:')).toBeLessThan(output.indexOf('B0200000004'));
  });

  it('prints the fiscal number in the minimal preset too', () => {
    const output = template.render({
      ...payload,
      options: {
        template: 'minimal',
        paperWidth: 48,
        currency: { symbol: 'DOP', decimals: 2, position: 'after' },
        fields: {
          logo: false, businessName: false, address: false, phone: false, email: false, website: false,
          taxId: false, orderNumber: true, dateTime: false, table: false, server: false, customer: false,
          orderMode: false, itemModifiers: false, itemNotes: false, unitPrice: false, taxBreakdown: false,
          discount: false, serviceCharge: false, tip: false, paymentMethod: false, amountPaid: false,
          change: false, qrCode: false, footerMessage: false, thankYou: false, poweredBy: false,
        },
      },
    } as unknown as Record<string, unknown>, capabilities).toString('latin1');

    expect(output).toContain('NCF/ECF');
    expect(output).toContain('B0200000004');
  });

  it('omits the fiscal line when the sale has no NCF/ECF', () => {
    const { ncf: _ncf, ...withoutNcf } = payload;
    const output = template.render(withoutNcf as unknown as Record<string, unknown>, capabilities).toString('latin1');

    expect(output).not.toContain('NCF/ECF');
  });
});
