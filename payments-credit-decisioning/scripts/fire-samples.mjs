import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function fireSamples(webhookUrl) {
	const names = readdirSync(join(root, 'samples'))
		.filter((name) => name.endsWith('.json'))
		.sort();
	const failures = [];
	for (const name of names) {
		const payload = JSON.parse(readFileSync(join(root, 'samples', name), 'utf8'));
		const expected = JSON.parse(readFileSync(join(root, 'expected', name), 'utf8'));
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = { raw: text };
		}
		const actual = stableView(body);
		const wanted = stableView(expected);
		if (response.status !== 200 || JSON.stringify(actual) !== JSON.stringify(wanted)) {
			failures.push({ name, status: response.status, actual, wanted });
			console.error(`FAIL ${name} HTTP ${response.status}`);
			continue;
		}
		console.log(`PASS ${name} ${body.decision} ${body.reason_codes.join(',')}`);
	}
	if (failures.length > 0) {
		console.error(JSON.stringify(failures, null, 2));
		throw new Error(`${failures.length} sample${failures.length === 1 ? '' : 's'} did not match.`);
	}
	console.log(`Fired ${names.length} samples at ${webhookUrl}`);
	return names.length;
}

export function stableView(value) {
	if (!value || typeof value !== 'object') return value;
	const copy = structuredClone(value);
	copy.decided_at = 'IGNORED';
	if (typeof copy.audit_card === 'string') {
		copy.audit_card = copy.audit_card.replace(/Decided at: .*/g, 'Decided at: IGNORED');
	}
	return copy;
}

if (process.argv[1] && process.argv[1].endsWith('fire-samples.mjs')) {
	const webhookUrl =
		process.argv[2] || process.env.DECISION_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/payments-decision';
	fireSamples(webhookUrl).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
