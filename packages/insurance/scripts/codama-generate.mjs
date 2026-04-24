// Codama -> TS client regenerator for `src/generated/`.
//
// WP-17: IDL is complete (11 instructions). USE_CODAMA = true.
// The hand-authored files under src/generated/ mirror what @codama/renderers-js
// emits. Running this script regenerates them from the canonical IDL.
// If @codama/nodes-from-anchor is not installed, install it first:
//   pnpm --filter @pact-network/insurance add -D @codama/nodes-from-anchor

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const IDL_PATH = resolve(ROOT, '../program/idl/pact_insurance.json');
const OUT_DIR = resolve(ROOT, 'src/generated');

const USE_CODAMA = true;

async function main() {
  const idlRaw = await readFile(IDL_PATH, 'utf-8');
  const idl = JSON.parse(idlRaw);
  const instructionCount = (idl.instructions ?? []).length;
  console.log(`[codama] IDL has ${instructionCount} instruction(s). OUT_DIR=${OUT_DIR}`);

  if (!USE_CODAMA) {
    console.log('[codama] USE_CODAMA=false — leaving hand-authored surface intact.');
    return;
  }

  const { rootNodeFromAnchor } = await import('@codama/nodes-from-anchor');
  const { renderVisitor } = await import('@codama/renderers-js');
  const { createFromRoot } = await import('codama');
  const codama = createFromRoot(rootNodeFromAnchor(idl));
  codama.accept(renderVisitor(OUT_DIR, { deleteFolderBeforeRendering: true }));
  console.log('[codama] generation complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
