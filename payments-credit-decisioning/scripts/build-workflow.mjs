import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, 'workflows', 'payments-credit-decisioning.json');

export function loadEngineSource() {
	const source = readFileSync(join(root, 'engine', 'decision-engine.mjs'), 'utf8');
	return source.replace(/^export /gm, '');
}

export function engineSha256() {
	return createHash('sha256').update(readFileSync(join(root, 'engine', 'decision-engine.mjs'))).digest('hex');
}

function codeNode(source, body) {
	return `// engine-sha256: ${engineSha256()}\n// Rebuild this node with: node scripts/build-workflow.mjs\n${source}\n${body}`;
}

const APPLY_POLICY_BODY = `const item = $input.first().json;
const payload = item && Object.prototype.hasOwnProperty.call(item, 'body') ? item.body : item;
const mode = String($env.DECISION_LLM_MODE || 'auto');
const apiKey = $env.NVIDIA_API_KEY;
const hasKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
const model = String($env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct');
let decision;
try {
  decision = decide(payload, { now: new Date().toISOString() });
} catch (error) {
  decision = decideFailure(error instanceof Error ? error.message : 'Policy failed.');
}
return [{
  json: {
    case_id: decision.case_id,
    audit_card: decision.audit_card,
    audit_line: decision.audit_line,
    response: decision.public,
    call_llm: shouldCallModel(decision, { mode, hasKey }),
    llm_request: buildLlmRequest(decision, model),
    decision_state: decision,
  },
}];`;

const APPLY_MODEL_BODY = `const prior = $('Apply policy').first().json;
const http = $input.first().json;
let decision = prior.decision_state;
if (!decision) {
  decision = decideFailure('The policy result was missing.');
}
const text = extractModelText(http);
if (text) {
  const model = prior.llm_request && prior.llm_request.model;
  decision = applyModelRationale(decision, text, { model });
} else {
  const reason = extractModelError(http) || 'The model returned no text.';
  decision = withModelFallback(decision, reason);
}
return [{
  json: {
    case_id: decision.case_id,
    audit_card: decision.audit_card,
    audit_line: decision.audit_line,
    response: decision.public,
    call_llm: false,
    llm_request: null,
    decision_state: decision,
  },
}];`;

export function buildWorkflow() {
	const source = loadEngineSource();
	const nvidiaUrl =
		"={{ ($env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\\/$/, '') + '/chat/completions' }}";

	return {
		id: 'paycredDecision',
		name: 'Payments & Credit Decisioning',
		nodes: [
			{
				parameters: {
					content:
						'## Payments and credit decisioning\n\nRules choose approve, review, or deny.\nThe model writes a rationale only for a review.\nThe model cannot change the decision.\n\nStripe amounts are cents. Plaid amounts are major units.\nVelocity counters arrive on the event. This workflow does not store payment history.\n\nSet NVIDIA_API_KEY to call NVIDIA on review cases. With no key, the mock rationale is used.',
					height: 280,
					width: 420,
					color: 4,
				},
				id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				name: 'Note',
				type: 'n8n-nodes-base.stickyNote',
				typeVersion: 1,
				position: [180, 40],
			},
			{
				parameters: {
					httpMethod: 'POST',
					path: 'payments-decision',
					authentication: 'none',
					responseMode: 'responseNode',
					options: {},
				},
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Webhook',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2.2,
				position: [220, 420],
				webhookId: 'paycred-webhook',
			},
			{
				parameters: {
					mode: 'runOnceForAllItems',
					language: 'javaScript',
					jsCode: codeNode(source, APPLY_POLICY_BODY),
				},
				id: '22222222-2222-4222-8222-222222222222',
				name: 'Apply policy',
				type: 'n8n-nodes-base.code',
				typeVersion: 2,
				position: [480, 420],
			},
			{
				parameters: {
					conditions: {
						options: {
							caseSensitive: true,
							leftValue: '',
							typeValidation: 'strict',
							version: 2,
						},
						conditions: [
							{
								id: 'call-llm',
								leftValue: '={{ $json.call_llm }}',
								rightValue: '',
								operator: {
									type: 'boolean',
									operation: 'true',
									singleValue: true,
								},
							},
						],
						combinator: 'and',
					},
					looseTypeValidation: false,
					options: {},
				},
				id: '33333333-3333-4333-8333-333333333333',
				name: 'Review needs a model',
				type: 'n8n-nodes-base.if',
				typeVersion: 2.2,
				position: [740, 420],
			},
			{
				parameters: {
					method: 'POST',
					url: nvidiaUrl,
					sendHeaders: true,
					specifyHeaders: 'keypair',
					headerParameters: {
						parameters: [
							{
								name: 'Authorization',
								value: '=Bearer {{ $env.NVIDIA_API_KEY }}',
							},
							{
								name: 'Content-Type',
								value: 'application/json',
							},
						],
					},
					sendBody: true,
					contentType: 'json',
					specifyBody: 'json',
					jsonBody: '={{ $json.llm_request }}',
					options: {
						timeout: 20000,
					},
				},
				id: '44444444-4444-4444-8444-444444444444',
				name: 'Ask NVIDIA for rationale',
				type: 'n8n-nodes-base.httpRequest',
				typeVersion: 4.2,
				position: [1000, 280],
				onError: 'continueRegularOutput',
			},
			{
				parameters: {
					mode: 'runOnceForAllItems',
					language: 'javaScript',
					jsCode: codeNode(source, APPLY_MODEL_BODY),
				},
				id: '55555555-5555-4555-8555-555555555555',
				name: 'Apply model rationale',
				type: 'n8n-nodes-base.code',
				typeVersion: 2,
				position: [1260, 280],
			},
			{
				parameters: {
					respondWith: 'json',
					responseBody: '={{ $json.response }}',
					options: {
						responseCode: 200,
					},
				},
				id: '66666666-6666-4666-8666-666666666666',
				name: 'Respond with decision',
				type: 'n8n-nodes-base.respondToWebhook',
				typeVersion: 1.4,
				position: [1520, 420],
			},
			{
				parameters: {
					operation: 'toText',
					sourceProperty: 'audit_card',
					binaryPropertyName: 'data',
					options: {
						fileName: "={{ $('Respond with decision').first().json.case_id }}.txt",
					},
				},
				id: '77777777-7777-4777-8777-777777777777',
				name: 'Build decision card file',
				type: 'n8n-nodes-base.convertToFile',
				typeVersion: 1.1,
				position: [1780, 300],
			},
			{
				parameters: {
					operation: 'write',
					fileName:
						"={{ ($env.DECISION_AUDIT_DIR || '/home/node/decision-audit') + '/cards/' + $('Respond with decision').first().json.case_id + '.txt' }}",
					dataPropertyName: 'data',
					options: {},
				},
				id: '88888888-8888-4888-8888-888888888888',
				name: 'Write decision card',
				type: 'n8n-nodes-base.readWriteFile',
				typeVersion: 1,
				position: [2020, 300],
			},
			{
				parameters: {
					operation: 'toText',
					sourceProperty: 'audit_line',
					binaryPropertyName: 'data',
					options: {
						fileName: 'audit.jsonl',
					},
				},
				id: '99999999-9999-4999-8999-999999999999',
				name: 'Build audit line file',
				type: 'n8n-nodes-base.convertToFile',
				typeVersion: 1.1,
				position: [1780, 540],
			},
			{
				parameters: {
					operation: 'write',
					fileName: "={{ ($env.DECISION_AUDIT_DIR || '/home/node/decision-audit') + '/audit.jsonl' }}",
					dataPropertyName: 'data',
					options: {
						append: true,
					},
				},
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				name: 'Append audit log',
				type: 'n8n-nodes-base.readWriteFile',
				typeVersion: 1,
				position: [2020, 540],
			},
		],
		connections: {
			Webhook: {
				main: [[{ node: 'Apply policy', type: 'main', index: 0 }]],
			},
			'Apply policy': {
				main: [[{ node: 'Review needs a model', type: 'main', index: 0 }]],
			},
			'Review needs a model': {
				main: [
					[{ node: 'Ask NVIDIA for rationale', type: 'main', index: 0 }],
					[{ node: 'Respond with decision', type: 'main', index: 0 }],
				],
			},
			'Ask NVIDIA for rationale': {
				main: [[{ node: 'Apply model rationale', type: 'main', index: 0 }]],
			},
			'Apply model rationale': {
				main: [[{ node: 'Respond with decision', type: 'main', index: 0 }]],
			},
			'Respond with decision': {
				main: [
					[
						{ node: 'Build decision card file', type: 'main', index: 0 },
						{ node: 'Build audit line file', type: 'main', index: 0 },
					],
				],
			},
			'Build decision card file': {
				main: [[{ node: 'Write decision card', type: 'main', index: 0 }]],
			},
			'Build audit line file': {
				main: [[{ node: 'Append audit log', type: 'main', index: 0 }]],
			},
		},
		settings: {
			executionOrder: 'v1',
		},
		pinData: {},
		meta: {
			templateCredsSetupCompleted: true,
			paymentsCreditDecisioning: {
				policy_version: 'payments-credit-v1',
				engine_sha256: engineSha256(),
			},
		},
	};
}

function writeWorkflow() {
	mkdirSync(dirname(workflowPath), { recursive: true });
	writeFileSync(workflowPath, `${JSON.stringify(buildWorkflow(), null, 2)}\n`);
}

function checkWorkflow() {
	const expected = `${JSON.stringify(buildWorkflow(), null, 2)}\n`;
	const current = readFileSync(workflowPath, 'utf8');
	if (current !== expected) {
		console.error('The workflow JSON does not match the engine. Run: node scripts/build-workflow.mjs');
		process.exit(1);
	}
	console.log('Workflow JSON matches the engine.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.includes('--check')) checkWorkflow();
	else {
		writeWorkflow();
		console.log(`Wrote ${workflowPath}`);
	}
}
