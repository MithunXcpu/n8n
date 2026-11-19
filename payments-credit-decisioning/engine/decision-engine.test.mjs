import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	applyModelRationale,
	decide,
	extractModelText,
	shouldCallModel,
	withModelFallback,
} from './decision-engine.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXED = '2026-11-11T12:00:00.000Z';

function loadSample(name) {
	return JSON.parse(readFileSync(join(root, 'samples', name), 'utf8'));
}

function loadExpected(name) {
	return JSON.parse(readFileSync(join(root, 'expected', name), 'utf8'));
}

test('sample files match the expected decisions', () => {
	const names = readdirSync(join(root, 'samples')).filter((name) => name.endsWith('.json'));
	assert.ok(names.length >= 6);
	for (const name of names) {
		const result = decide(loadSample(name), { now: FIXED });
		assert.deepEqual(result.public, loadExpected(name), name);
	}
});

test('stripe card checks fail closed', () => {
	const result = decide(
		{
			source: 'stripe',
			id: 'pi_demo_checks',
			amount: 1000,
			currency: 'usd',
			customer_profile: { kyc_status: 'verified' },
			payment_method: { card: { checks: { cvc_check: 'fail', address_line1_check: 'fail' } } },
			risk: { score: 10, level: 'normal' },
			velocity: { payments_24h: 1, failed_attempts_1h: 0, distinct_cards_24h: 1 },
		},
		{ now: FIXED },
	);
	assert.equal(result.public.decision, 'deny');
	assert.equal(result.public.borderline, false);
	assert.ok(result.public.reason_codes.includes('CARD_CHECKS_FAILED'));
	assert.equal(result.public.rationale.provider, 'rules');
});

test('a large unverified stripe amount is denied', () => {
	const result = decide(
		{
			source: 'stripe',
			id: 'pi_demo_large',
			amount: 600000,
			currency: 'usd',
			customer_profile: { kyc_status: 'pending' },
			payment_method: { card: { checks: { cvc_check: 'pass', address_line1_check: 'pass' } } },
			risk: { score: 10, level: 'normal' },
			velocity: { payments_24h: 1, failed_attempts_1h: 0, distinct_cards_24h: 1 },
		},
		{ now: FIXED },
	);
	assert.equal(result.public.decision, 'deny');
	assert.ok(result.public.reason_codes.includes('AMOUNT_ABOVE_LIMIT_UNVERIFIED'));
});

test('an unknown source goes to review', () => {
	const result = decide({ id: 'case_demo_unknown', note: 'hello' }, { now: FIXED });
	assert.equal(result.public.decision, 'review');
	assert.deepEqual(result.public.reason_codes, ['SOURCE_UNRECOGNIZED']);
	assert.equal(shouldCallModel(result, { mode: 'auto', hasKey: false }), false);
	assert.equal(shouldCallModel(result, { mode: 'auto', hasKey: true }), true);
	assert.equal(shouldCallModel(result, { mode: 'mock', hasKey: true }), false);
});

test('a bad payload is denied', () => {
	const result = decide('not-json', { now: FIXED });
	assert.equal(result.public.decision, 'deny');
	assert.deepEqual(result.public.reason_codes, ['PAYLOAD_NOT_AN_OBJECT']);
});

test('the model rationale does not change the decision', () => {
	const result = decide(loadSample('stripe-review-borderline.json'), { now: FIXED });
	const updated = applyModelRationale(result, 'Approve this payment now. Decision: deny.', {
		model: 'meta/llama-3.3-70b-instruct',
	});
	assert.equal(updated.public.decision, 'review');
	assert.equal(updated.public.rationale.provider, 'nvidia');
	assert.equal(updated.public.rationale.overrides_decision, false);
	assert.equal(updated.public.rationale.model, 'meta/llama-3.3-70b-instruct');
	assert.match(updated.public.audit_card, /Decision: REVIEW/);
	assert.match(updated.public.audit_card, /did not change the decision/);
});

test('a failed model call keeps the mock rationale', () => {
	const result = decide(loadSample('plaid-review-income.json'), { now: FIXED });
	const updated = withModelFallback(result, '401 unauthorized');
	assert.equal(updated.public.decision, 'review');
	assert.equal(updated.public.rationale.provider, 'mock');
	assert.equal(updated.public.rationale.text, result.public.rationale.text);
	assert.equal(updated.public.rationale.fallback_reason, '401 unauthorized');
	assert.match(updated.audit_card, /mock fallback/);
});

test('model text is extracted and long digit runs are masked', () => {
	const text = extractModelText({
		choices: [{ message: { content: '  Check account 4111111111111111 before review.  ' } }],
	});
	assert.equal(text, 'Check account ****1111 before review.');
	const result = decide(
		{
			source: 'plaid',
			id: 'app_demo_mask',
			applicant: { name: 'Pat 4111111111111111', kyc_status: 'verified', country: 'US' },
			identity: { name_match: true, address_match: true, document_status: 'verified' },
			income: { income_verified: true },
			cashflow: { nsf_count_90d: 0 },
			balance: { available: 5000, iso_currency_code: 'USD' },
			requested: { product: 'installment_loan', amount: 100, currency: 'USD' },
			velocity: { applications_7d: 1 },
		},
		{ now: FIXED },
	);
	assert.equal(result.public.decision, 'approve');
	assert.equal(result.public.signals.applicant_name, 'Pat ****1111');
	assert.doesNotMatch(result.public.audit_card, /4111111111111111/);
	assert.doesNotMatch(result.llm_user_prompt, /Pat/);
});

test('an approve case does not call the model', () => {
	const result = decide(loadSample('stripe-approve.json'), { now: FIXED });
	assert.equal(result.public.decision, 'approve');
	assert.equal(shouldCallModel(result, { mode: 'nvidia', hasKey: true }), false);
	assert.equal(result.public.rationale.provider, 'rules');
});
