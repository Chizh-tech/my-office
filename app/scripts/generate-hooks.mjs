import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLACEHOLDER = '__MY_OFFICE_BRIDGE__';
const TEMPLATES = [
  ['my-office.hooks.example.json', 'vscode-hooks.json'],
  ['copilot-cli.hooks.example.json', 'copilot-cli-hooks.json'],
];

export async function generateHookConfigs(outputDirectory = resolve(APP_ROOT, '.local', 'generated-hooks')) {
  const bridgePath = fileURLToPath(new URL('../src/bridge-hook.mjs', import.meta.url)).replaceAll('\\', '/');
  const outputs = [];
  await mkdir(outputDirectory, { recursive: true });
  for (const [templateName, outputName] of TEMPLATES) {
    const template = await readFile(resolve(APP_ROOT, 'hooks', templateName), 'utf8');
    if (!template.includes(PLACEHOLDER)) throw new Error(`Hook template is missing ${PLACEHOLDER}: ${templateName}`);
    const outputPath = resolve(outputDirectory, outputName);
    await writeFile(outputPath, template.replaceAll(PLACEHOLDER, bridgePath), { encoding: 'utf8', mode: 0o600 });
    outputs.push(outputPath);
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/generate-hooks.mjs [output-directory]');
  const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : undefined;
  for (const output of await generateHookConfigs(outputDirectory)) console.log(output);
}
