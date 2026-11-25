import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACK_DIR = resolve(process.cwd());
const PRODUCT_DIR = resolve(PACK_DIR, '..');
const DIST_DIR = join(PRODUCT_DIR, 'dist');
const STAGE_DIR = join(DIST_DIR, '_stage_pack');
const UNPACK_DIR = join(DIST_DIR, '_verify_unpack');
const ZIP_PATH = join(DIST_DIR, 'web3-ops-automation-pack-v1.0.0.zip');
const SHA_PATH = join(DIST_DIR, 'web3-ops-automation-pack-v1.0.0.zip.sha256');

rmSync(STAGE_DIR, { recursive: true, force: true });
rmSync(UNPACK_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });
mkdirSync(UNPACK_DIR, { recursive: true });

const INCLUDE = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'LICENSE.txt',
  'docs',
  'base-usdc-watcher',
  'solana-usdc-verifier',
  'playwright-crypto-qa',
  'n8n-webhooks'
];

for (const item of INCLUDE) {
  cpSync(join(PACK_DIR, item), join(STAGE_DIR, item), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('__pycache__')
  });
}

if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
execFileSync('tar', ['-a', '-cf', ZIP_PATH, '-C', STAGE_DIR, '.'], { stdio: 'inherit' });

const zipBytes = readFileSync(ZIP_PATH);
const sha256 = createHash('sha256').update(zipBytes).digest('hex');
writeFileSync(SHA_PATH, `${sha256}  web3-ops-automation-pack-v1.0.0.zip\n`, 'utf8');

// Clean-room unpack & test verification (no node_modules needed for pure Node/Python tests)
execFileSync('tar', ['-xf', ZIP_PATH, '-C', UNPACK_DIR], { stdio: 'inherit' });
execFileSync(
  'node',
  [
    '--test',
    'base-usdc-watcher/tests/watcher.test.mjs',
    'solana-usdc-verifier/tests/verifier.test.mjs',
    'n8n-webhooks/tests/workflows.test.mjs'
  ],
  { cwd: UNPACK_DIR, stdio: 'inherit' }
);
execFileSync(
  'python',
  ['-m', 'unittest', 'discover', '-s', 'base-usdc-watcher/python', '-p', 'test_*.py'],
  { cwd: UNPACK_DIR, stdio: 'inherit' }
);
execFileSync(
  'python',
  ['-m', 'unittest', 'discover', '-s', 'solana-usdc-verifier/python', '-p', 'test_*.py'],
  { cwd: UNPACK_DIR, stdio: 'inherit' }
);

rmSync(STAGE_DIR, { recursive: true, force: true });
rmSync(UNPACK_DIR, { recursive: true, force: true });
console.log(`Bundle verified cleanly: ${ZIP_PATH} (sha256=${sha256})`);
