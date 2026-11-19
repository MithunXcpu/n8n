import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';

import { buildWorkflow, engineSha256 } from './build-workflow.mjs';
import { stableView } from './fire-samples.mjs';

const workflow = buildWorkflow();

function nodeByName(name) {
	const node = workflow.nodes.find((entry) => entry.name === name);
	assert.ok(node, name);
	return node;
}

function targets(name) {
	const links = workflow.connections[name]?.main ?? [];
	return links.map((output) => output.map((link) => link.node));
}

export function runNodeCode(jsCode, sandbox) {
	const wrapped = `'use strict';\n(function () {\n${jsCode}\n})()`;
	return vm.runInNewContext(wrapped, sandbox, { timeout: 2000 });
}

test('the workflow graph reaches a response and both audit writes', () => {
	assert.deepEqual(targets('Webhook'), [['Apply policy']]);
	assert.deepEqual(targets('Apply policy'), [['Review needs a model']]);
	assert.deepEqual(targets('Review needs a model'), [
		['Ask NVIDIA for rationale'],
		['Respond with decision'],
	]);
	assert.deepEqual(targets('Ask NVIDIA for rationale'), [['Apply model rationale']]);
	assert.deepEqual(targets('Apply model rationale'), [['Respond with decision']]);
	assert.deepEqual(targets('Respond with decision'), [['Build decision card file', 'Build audit line file']]);
	assert.equal(nodeByName('Webhook').parameters.path, 'payments-decision');
	assert.equal(nodeByName('Webhook').parameters.responseMode, 'responseNode');
	assert.equal(nodeByName('Ask NVIDIA for rationale').onError, 'continueRegularOutput');
	assert.match(nodeByName('Ask NVIDIA for rationale').parameters.url, /integrate\.api\.nvidia\.com/);
	assert.equal(workflow.meta.paymentsCreditDecisioning.engine_sha256, engineSha256());
	assert.doesNotMatch(JSON.stringify(workflow), /nvapi-|sk-/);
});

test('embedded code nodes parse', () => {
	for (const name of ['Apply policy', 'Apply model rationale']) {
		const dir = mkdtempSync(join(tmpdir(), 'decision-code-'));
		const file = join(dir, 'node.js');
		writeFileSync(file, `'use strict';\n(function () {\n${nodeByName(name).parameters.jsCode}\n});\n`);
		const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	}
});

test('offline mode matches expected decisions and skips the model', () => {
	const names = ['stripe-approve.json', 'stripe-review-borderline.json', 'plaid-deny-nsf.json', 'plaid-review-income.json'];
	for (const name of names) {
		const payload = JSON.parse(readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8'));
		const expected = JSON.parse(readFileSync(new URL(`../expected/${name}`, import.meta.url), 'utf8'));
		const output = runNodeCode(nodeByName('Apply policy').parameters.jsCode, {
			$input: { first: () => ({ json: { body: payload } }) },
			$env: {
				DECISION_LLM_MODE: 'auto',
				NVIDIA_API_KEY: '',
				NVIDIA_MODEL: 'meta/llama-3.3-70b-instruct',
			},
		});
		assert.equal(output.length, 1);
		assert.equal(output[0].json.call_llm, false, name);
		const actual = stableView(output[0].json.response);
		const wanted = stableView(expected);
		assert.deepEqual(actual, wanted, name);
		assert.match(output[0].json.audit_card, new RegExp(`Decision: ${expected.decision.toUpperCase()}`));
	}
});

test('the committed workflow matches the engine source', () => {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const committed = readFileSync(join(root, 'workflows', 'payments-credit-decisioning.json'), 'utf8');
	assert.equal(committed, `${JSON.stringify(buildWorkflow(), null, 2)}\n`);
	assert.match(committed, new RegExp(engineSha256()));
});

test('a mock NVIDIA response explains a review and does not change it', () => {
	const payload = JSON.parse(
		readFileSync(new URL('../samples/stripe-review-borderline.json', import.meta.url), 'utf8'),
	);
	const policy = runNodeCode(nodeByName('Apply policy').parameters.jsCode, {
		$input: { first: () => ({ json: { body: payload } }) },
		$env: {
			DECISION_LLM_MODE: 'nvidia',
			NVIDIA_API_KEY: 'demo-not-a-real-key',
			NVIDIA_MODEL: 'meta/llama-3.3-70b-instruct',
		},
	})[0].json;
	assert.equal(policy.call_llm, true);
	assert.equal(policy.llm_request.model, 'meta/llama-3.3-70b-instruct');
	assert.equal(policy.llm_request.messages[0].role, 'system');
	assert.match(policy.llm_request.messages[1].content, /REVIEW/);

	const mockHttp = {
		choices: [
			{
				message: {
					content: 'Check the pending KYC record and the amount before you release this payment.',
				},
			},
		],
	};
	const applied = runNodeCode(nodeByName('Apply model rationale').parameters.jsCode, {
		$input: { first: () => ({ json: mockHttp }) },
		$: (nodeName) => {
			assert.equal(nodeName, 'Apply policy');
			return { first: () => ({ json: policy }) };
		},
	})[0].json;

	assert.equal(applied.response.decision, 'review');
	assert.deepEqual(applied.response.reason_codes, policy.response.reason_codes);
	assert.equal(applied.response.rationale.provider, 'nvidia');
	assert.equal(applied.response.rationale.overrides_decision, false);
	assert.match(applied.response.rationale.text, /pending KYC/);
	assert.match(applied.audit_card, /did not change the decision/);

	const failed = runNodeCode(nodeByName('Apply model rationale').parameters.jsCode, {
		$input: { first: () => ({ json: { error: { message: '401 unauthorized' } } }) },
		$: () => ({ first: () => ({ json: policy }) }),
	})[0].json;
	assert.equal(failed.response.decision, 'review');
	assert.equal(failed.response.rationale.provider, 'mock');
	assert.equal(failed.response.rationale.fallback_reason, '401 unauthorized');
	assert.equal(failed.response.rationale.text, policy.response.rationale.text);
});
