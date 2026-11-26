import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_PATTERNS = [/sk_live_/i, /ghp_[A-Za-z0-9]{20,}/, /PRIVATE KEY/];
const UNSAFE_CODE_PATTERNS = [
  /19000000n/,
  /Number\(t\.tokenAmount\)/,
  /parseInt\([^)]*blockNumber/
];

export function validateN8nWorkflowFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(raw)) {
      throw new Error(`Hardcoded secret pattern matched in ${filePath}: ${pat}`);
    }
  }
  const wf = JSON.parse(raw);
  if (!wf.name || !Array.isArray(wf.nodes) || wf.nodes.length === 0) {
    throw new Error(`Invalid workflow structure in ${filePath}`);
  }
  const nodeNames = new Set(wf.nodes.map((n) => n.name));
  if (nodeNames.size !== wf.nodes.length) {
    throw new Error(`Duplicate node names in ${filePath}`);
  }
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.webhook') {
      if (node.parameters?.responseMode === 'onReceived') {
        throw new Error(
          `Unsafe responseMode "onReceived" in ${filePath} (${node.name}); use "lastNode" or "responseNode" so auth/RPC run before responding`
        );
      }
    }
    if (node.type === 'n8n-nodes-base.httpRequest') {
      if (node.parameters?.sendBody && node.parameters?.specifyBody !== 'json') {
        throw new Error(
          `Missing specifyBody: "json" on httpRequest v4 node in ${filePath} (${node.name})`
        );
      }
    }
    if (node.type === 'n8n-nodes-base.code') {
      const code = String(node.parameters?.jsCode || '');
      for (const pat of UNSAFE_CODE_PATTERNS) {
        if (pat.test(code)) {
          throw new Error(`Unsafe code pattern matched in ${filePath} (${node.name}): ${pat}`);
        }
      }
      if (!code.includes('WEBHOOK_HMAC_SECRET')) {
        throw new Error(`Missing WEBHOOK_HMAC_SECRET verification in ${filePath} (${node.name})`);
      }
      if (!code.includes('x-webhook-timestamp')) {
        throw new Error(`Missing x-webhook-timestamp replay check in ${filePath} (${node.name})`);
      }
      if (!code.includes('JSON.parse(rawPayload)')) {
        throw new Error(`Must parse HMAC-verified rawPayload via JSON.parse(rawPayload) in ${filePath} (${node.name})`);
      }
      if (!code.includes('AbortSignal.timeout')) {
        throw new Error(`Missing AbortSignal.timeout on RPC fetch in ${filePath} (${node.name})`);
      }
    }
  }
  for (const [src, edges] of Object.entries(wf.connections || {})) {
    if (!nodeNames.has(src)) {
      throw new Error(`Connection source "${src}" missing in ${filePath}`);
    }
    for (const branch of edges.main || []) {
      for (const target of branch) {
        if (!nodeNames.has(target.node)) {
          throw new Error(`Connection target "${target.node}" missing in ${filePath}`);
        }
      }
    }
  }
  return { name: wf.name, nodeCount: wf.nodes.length };
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const targets =
    process.argv.length > 2
      ? process.argv.slice(2).map((p) => resolve(p))
      : readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => join(dir, f));

  if (targets.length === 0) {
    console.error('No workflow JSON files found to validate.');
    process.exit(1);
  }
  for (const file of targets) {
    const res = validateN8nWorkflowFile(file);
    console.log(`PASS ${res.name} (${res.nodeCount} nodes): ${file}`);
  }
}
