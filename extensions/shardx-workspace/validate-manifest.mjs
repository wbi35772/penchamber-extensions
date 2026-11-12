import { readFileSync } from 'node:fs';
import { parseManifestJson } from './node_modules/@openchamber/sdk/dist/parse.js';

const path = process.argv[2];
const json = readFileSync(path, 'utf8');
const result = parseManifestJson(json);
if (result.ok) {
  console.log('OK');
  console.log('version:', result.version);
  console.log('panel:', JSON.stringify(result.manifest.contributes.panel));
} else {
  console.log('FAIL', result.code);
  console.log(result.message);
  process.exit(1);
}
