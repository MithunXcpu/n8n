import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../engine/decision-engine.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedDir = join(root, 'expected');
mkdirSync(expectedDir, { recursive: true });

const fixed = '2026-11-11T12:00:00.000Z';
for (const name of readdirSync(join(root, 'samples')).filter((file) => file.endsWith('.json'))) {
	const payload = JSON.parse(readFileSync(join(root, 'samples', name), 'utf8'));
	const result = decide(payload, { now: fixed });
	writeFileSync(join(expectedDir, name), `${JSON.stringify(result.public, null, 2)}\n`);
	console.log(`${name} ${result.public.decision} ${result.public.reason_codes.join(',')}`);
}
