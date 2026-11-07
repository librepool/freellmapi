/**
 * Sign a catalog JSON document (mirrors the upstream layout the router's
 * export script references: catalog/src/scripts/sign-catalog.ts).
 *
 * Usage: node scripts/sign-catalog.ts --in <catalog.json> [--out <signed.json>]
 *   --key <private-key-pem>   (defaults to CATALOG_SIGNING_KEY_PATH or
 *                              ./dev-keys/signing-private.pem)
 * With --out, writes the document plus its base64 signature to a sidecar
 * JSON { document, signature }; without it, prints the signature to stdout.
 * The live service signs the exact bytes it serves at request time — this
 * script is for offline/batched signing and verification checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPrivateKey, signBytes } from '../src/signing.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const inPath = arg('in');
  if (!inPath) {
    console.error('Usage: node scripts/sign-catalog.ts --in <catalog.json> [--out <signed.json>] [--key <private-key-pem>]');
    process.exit(2);
  }
  if (arg('key')) process.env.CATALOG_SIGNING_KEY_PATH = path.resolve(arg('key')!);
  const bytes = fs.readFileSync(inPath);
  const privateKey = loadPrivateKey();
  const signature = signBytes(privateKey, bytes);
  const outPath = arg('out');
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ document: JSON.parse(bytes.toString('utf8')), signature }, null, 2) + '\n');
    console.log(`Signed ${inPath} -> ${outPath}`);
  } else {
    console.log(signature);
  }
}

main();
