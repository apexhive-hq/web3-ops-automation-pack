import { readFileSync } from 'node:fs';

const SECRET_PATTERNS = [/sk_live_/i, /ghp_[A-Za-z0-9]{20,}/, /PRIVATE KEY/];

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
