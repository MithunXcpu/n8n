import { checkAuditFiles } from './check-audit.mjs';
import { fireSamples } from './fire-samples.mjs';
import { importAndPublish } from './import-and-publish.mjs';

const auditDir = process.env.DECISION_AUDIT_DIR || '/home/node/decision-audit';

const { webhookUrl } = await importAndPublish();
await fireSamples(webhookUrl);
await checkAuditFiles(auditDir);
console.log('Smoke test passed.');
