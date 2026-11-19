import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { api, login, n8nConfig, waitForHealth } from './n8n-client.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function importAndPublish() {
	const config = n8nConfig();
	await waitForHealth(config.baseUrl);
	const cookie = await login(config);
	const workflow = JSON.parse(
		readFileSync(join(root, 'workflows', 'payments-credit-decisioning.json'), 'utf8'),
	);
	await replaceWorkflow(config, cookie, workflow);
	const published = await publishWorkflow(config, cookie);
	const webhookUrl = `${config.baseUrl}/webhook/payments-decision`;
	console.log(`Published workflow ${published.id}.`);
	console.log(`Webhook: ${webhookUrl}`);
	return { config, cookie, webhookUrl, workflow: published };
}

async function replaceWorkflow(config, cookie, workflow) {
	const existing = await api(config, cookie, `/rest/workflows/${config.workflowId}`);
	if (existing.status === 200) {
		await api(config, cookie, `/rest/workflows/${config.workflowId}/deactivate`, {
			method: 'POST',
			body: '{}',
		});
		const removed = await api(config, cookie, `/rest/workflows/${config.workflowId}`, { method: 'DELETE' });
		if (removed.status >= 400) {
			throw new Error(`Delete failed (${removed.status}): ${JSON.stringify(removed.body)}`);
		}
	}
	const created = await api(config, cookie, '/rest/workflows', {
		method: 'POST',
		body: JSON.stringify(workflow),
	});
	if (created.status >= 400) {
		throw new Error(`Import failed (${created.status}): ${JSON.stringify(created.body)}`);
	}
	return created.body;
}

async function publishWorkflow(config, cookie) {
	const loaded = await api(config, cookie, `/rest/workflows/${config.workflowId}`);
	if (loaded.status >= 400) {
		throw new Error(`Load failed (${loaded.status}): ${JSON.stringify(loaded.body)}`);
	}
	const versionId = loaded.body?.versionId || loaded.body?.version?.id;
	if (!versionId) {
		throw new Error(`The workflow has no versionId. Keys: ${Object.keys(loaded.body || {}).join(', ')}`);
	}
	const published = await api(config, cookie, `/rest/workflows/${config.workflowId}/activate`, {
		method: 'POST',
		body: JSON.stringify({
			versionId,
			name: 'Decisioning demo',
			description: 'Published by the payments and credit decisioning workbench.',
		}),
	});
	if (published.status >= 400) {
		throw new Error(`Publish failed (${published.status}): ${JSON.stringify(published.body)}`);
	}
	return published.body;
}

if (process.argv[1] && process.argv[1].endsWith('import-and-publish.mjs')) {
	importAndPublish().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
