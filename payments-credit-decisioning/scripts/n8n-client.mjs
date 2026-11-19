const DEFAULT_BASE = 'http://127.0.0.1:5678';

export function n8nConfig() {
	return {
		baseUrl: (process.env.N8N_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''),
		email: process.env.DEMO_OWNER_EMAIL || 'demo.owner@example.com',
		password: process.env.DEMO_OWNER_PASSWORD || 'DecisionDemo123!',
		browserId: 'payments-credit-workbench',
		workflowId: 'paycredDecision',
	};
}

export async function waitForHealth(baseUrl, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	let lastError = 'n8n did not answer';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await delay(1000);
	}
	throw new Error(lastError);
}

export async function login(config) {
	const response = await fetch(`${config.baseUrl}/rest/login`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'browser-id': config.browserId,
		},
		body: JSON.stringify({
			emailOrLdapLoginId: config.email,
			password: config.password,
		}),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(`Login failed (${response.status}): ${JSON.stringify(body)}`);
	}
	const cookie = cookieHeader(response);
	if (!cookie) throw new Error('Login did not return an auth cookie.');
	return cookie;
}

export async function api(config, cookie, path, options = {}) {
	const response = await fetch(`${config.baseUrl}${path}`, {
		...options,
		headers: {
			'content-type': 'application/json',
			'browser-id': config.browserId,
			cookie,
			...(options.headers || {}),
		},
	});
	const text = await response.text();
	let body = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { status: response.status, body };
}

function cookieHeader(response) {
	const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	if (list.length > 0) return list.map((entry) => entry.split(';')[0]).join('; ');
	const single = response.headers.get('set-cookie');
	if (!single) return '';
	return single
		.split(',')
		.map((entry) => entry.split(';')[0].trim())
		.join('; ');
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
