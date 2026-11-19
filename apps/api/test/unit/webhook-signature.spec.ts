import type { Request } from 'express';
import { verifyDelivery } from '../../src/webhooks/webhook-signature';
import { signedHeaders } from '../helpers/webhook';

const workflow = 'd4a8a037-6fdd-4ed3-a199-143ca6755d77',
  body = '{ "ok": true }',
  now = 1800000000;
const keys = {
  webhookKeyId: 'key1',
  webhookSecret: 'fixture-current',
  nextWebhookKeyId: 'key2',
  nextWebhookSecret: 'fixture-next',
};
const request = (h: Record<string, string | string[]>): Request =>
  ({
    headersDistinct: Object.fromEntries(
      Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
    ),
  }) as unknown as Request;
const mac = (offset = 0) =>
  signedHeaders(workflow, keys.webhookSecret, body, 'order-A', now + offset);
describe('webhook v1', () => {
  it.each([-301, -300, 0, 300, 301])(
    'checks the signed second at offset %i',
    (delta) => {
      const result = verifyDelivery(
        request(mac(delta)),
        workflow,
        Buffer.from(body),
        keys,
        now,
      );
      expect(Boolean(result)).toBe(Math.abs(delta) <= 300);
    },
  );
  it.each([
    { 'x-webhook-delivery-id': 'other' },
    { 'x-webhook-timestamp': '01800000000' },
    { 'x-signature': 'v1=00' },
    { 'x-webhook-delivery-id': ['order-A', 'order-A'] },
  ])('rejects altered or ambiguous headers', (change) => {
    expect(
      verifyDelivery(
        request({ ...mac(), ...change }),
        workflow,
        Buffer.from(body),
        keys,
        now,
      ),
    ).toBeUndefined();
  });
  it('binds the signed bytes and destination as well as the delivery ID', () => {
    expect(
      verifyDelivery(
        request(mac()),
        workflow,
        Buffer.from(body.trim() + ' '),
        keys,
        now,
      ),
    ).toBeUndefined();
    expect(
      verifyDelivery(
        request(mac()),
        '04a8a037-6fdd-4ed3-a199-143ca6755d77',
        Buffer.from(body),
        keys,
        now,
      ),
    ).toBeUndefined();
  });
});
