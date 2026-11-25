import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { validateN8nWorkflowFile } from '../validate-workflows.mjs';

test('all n8n webhook JSON workflows pass DAG & secret hygiene validation', () => {
  const dir = join(process.cwd(), 'n8n-webhooks');
  const r1 = validateN8nWorkflowFile(join(dir, 'base-usdc-payment-alert.json'));
  const r2 = validateN8nWorkflowFile(join(dir, 'solana-pay-invoice-webhook.json'));

  assert.equal(r1.nodeCount, 3);
  assert.equal(r2.nodeCount, 3);
});
