/**
 * API contract for POST /api/print with the label template.
 *
 * Uses the ApiServer's getApp() test seam with stubbed queue/printers so the
 * assertions stay on the HTTP contract: an invalid payload must be rejected
 * with 400 BEFORE a job is enqueued, not enqueued and dead-lettered later.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { ApiServer } from '../src/api/server';
import { TemplateEngine } from '../src/templates/engine';
import { Logger } from '../src/utils/logger';
import { SecurityConfig } from '../src/types';

const security: SecurityConfig = {
  allowedOrigins: [],
  allowedHosts: [],
  rateLimitPerMinute: 1000,
  enableApiKey: false,
  maxPayloadSize: 1048576,
  allowPrivateNetwork: true
};

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** Minimal print-manager stand-in: nothing is touched before validation fires. */
const printerManager = {
  getPrintSystem: () => ({}),
  getPrinter: () => ({ id: 'label', enabled: true, capabilities: {} }),
  getDefaultPrinter: () => null
} as never;

const processor = {} as never;
const configManager = {} as never;

function makeServer() {
  const enqueue = jest.fn(() => ({ created: true, job: { id: 'job-1', status: 'pending' } }));
  const server = new ApiServer(
    { enqueue } as never,
    printerManager,
    processor,
    {
      host: '127.0.0.1',
      port: 0,
      security,
      configManager,
      templateEngine: new TemplateEngine()
    },
    logger
  );
  return { server, enqueue };
}

let url: string;
let httpServer: http.Server;
let enqueue: jest.Mock;

beforeAll((done) => {
  const made = makeServer();
  enqueue = made.enqueue;
  httpServer = made.server.getApp().listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/api/print`;
    done();
  });
});

afterAll(() => {
  httpServer.close();
});

const post = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = (await r.json()) as Record<string, unknown>;
  return { status: r.status, body: json };
};

describe('POST /api/print payload validation', () => {
  it('rejects an invalid label payload with 400 and never enqueues', async () => {
    const { status, body } = await post({
      idempotencyKey: 'bad-label-1',
      printerId: 'label',
      templateType: 'label',
      payload: { barcode: '' }
    });

    expect(status).toBe(400);
    expect(body.error).toBe('JOB_INVALID_PAYLOAD');
    expect(String(body.message)).toContain('Invalid payload for template');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a non-string barcode the same way', async () => {
    const { status } = await post({
      idempotencyKey: 'bad-label-2',
      printerId: 'label',
      templateType: 'label',
      payload: { barcode: { value: 'ABC123' } }
    });

    expect(status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts a valid label payload and enqueues exactly one job', async () => {
    const { status, body } = await post({
      idempotencyKey: 'good-label-1',
      printerId: 'label',
      templateType: 'label',
      payload: { barcode: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' }
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('job-1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      printerId: 'label',
      templateType: 'label',
      payload: { barcode: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' }
    });
  });
});
