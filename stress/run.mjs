/**
 * Runs the JS half of the stress suite end to end: boots the adversarial server,
 * runs each scenario against it, then shuts it down.
 *
 *   npm run stress
 *
 * The Android half is a Gradle task and needs no server — see stress/README.md.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STRESS_PORT ?? 3111);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/health', timeout: 500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const server = spawn(process.execPath, [path.join(here, 'server.mjs'), String(PORT)], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(100);
  up = await ping();
}
if (!up) {
  server.kill('SIGKILL');
  console.error(`[stress] servidor nao arrancou na porta ${PORT}`);
  process.exit(1);
}

const scenarios = [
  ['Fronteira UTF-8 no transporte nativo (simulado sobre HTTP real)', 'wire.mjs'],
  ['Parser: fuzz de fronteiras, limites de recursos, complexidade', 'parser.mjs'],
];

let failed = 0;
for (const [title, script] of scenarios) {
  console.log(`\n${'═'.repeat(72)}\n${title}\n${'═'.repeat(72)}`);
  const child = spawn(
    process.execPath,
    ['--expose-gc', path.join(here, script)],
    { stdio: 'inherit', env: { ...process.env, STRESS_PORT: String(PORT) } },
  );
  const [code] = await once(child, 'exit');
  if (code !== 0) failed++;
}

server.kill('SIGTERM');
await sleep(150);
server.kill('SIGKILL');

console.log(`\n${'═'.repeat(72)}`);
console.log('Metade Android da suite:');
console.log('  cd example-expo/android && ./gradlew :jose-native-sse:testDebugUnitTest');
console.log(`${'═'.repeat(72)}`);

process.exit(failed ? 1 : 0);
