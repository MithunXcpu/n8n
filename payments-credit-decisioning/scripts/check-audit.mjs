import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function checkAuditFiles(auditDir) {
	const names = readdirSync(join(root, 'expected')).filter((name) => name.endsWith('.json'));
	const deadline = Date.now() + 15000;
	let missing = [];
	while (Date.now() < deadline) {
		missing = findMissing(auditDir, names);
		if (missing.length === 0) {
			console.log(`Audit log has ${names.length} decision cards in ${auditDir}`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Audit files are incomplete:\n${missing.join('\n')}`);
}

function findMissing(auditDir, names) {
	const missing = [];
	for (const name of names) {
		const expected = JSON.parse(readFileSync(join(root, 'expected', name), 'utf8'));
		const cardPath = join(auditDir, 'cards', `${expected.case_id}.txt`);
		let card = '';
		try {
			card = readFileSync(cardPath, 'utf8');
		} catch {
			missing.push(cardPath);
			continue;
		}
		if (!card.includes(`Case: ${expected.case_id}`)) missing.push(`${cardPath} missing case id`);
		if (!card.includes(`Decision: ${expected.decision.toUpperCase()}`)) {
			missing.push(`${cardPath} missing decision`);
		}
	}
	const logPath = join(auditDir, 'audit.jsonl');
	let lines = '';
	try {
		lines = readFileSync(logPath, 'utf8');
	} catch {
		missing.push(logPath);
	}
	for (const name of names) {
		const expected = JSON.parse(readFileSync(join(root, 'expected', name), 'utf8'));
		if (!lines.includes(`"case_id":"${expected.case_id}"`)) {
			missing.push(`audit log missing ${expected.case_id}`);
		}
	}
	return missing;
}
