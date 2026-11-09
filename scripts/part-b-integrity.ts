import fs from 'fs';
import path from 'path';
import { getPool } from '../src/database/connection.js';

interface AuditCheck {
  id: string;
  name: string;
  description: string;
  query: string;
  violationsFound: number;
  passed: boolean;
  sampleViolations?: any[];
}

async function runIntegrityAudit() {
  console.log('================================================================');
  console.log('    ZeTheta Payment Platform - Financial & State Integrity      ');
  console.log('                 10 Invariant SQL Verification                  ');
  console.log('================================================================\n');

  const pool = getPool();
  const checks: AuditCheck[] = [
    {
      id: 'Q01',
      name: 'Zero Orphan Payment Attempts',
      description: 'Every payment attempt must reference an existing transaction.',
      query: `
        SELECT pa.id, pa.transaction_id
        FROM payment_attempts pa
        LEFT JOIN transactions t ON pa.transaction_id = t.id
        WHERE t.id IS NULL;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q02',
      name: 'Financial Arithmetic Invariants',
      description: 'captured <= authorized AND (refunded + reserved) <= captured.',
      query: `
        SELECT id, authorized_minor, captured_minor, refunded_minor, reserved_refund_minor
        FROM transactions
        WHERE captured_minor > authorized_minor 
           OR (refunded_minor + reserved_refund_minor) > captured_minor;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q03',
      name: 'Audit Ledger Trigger Active',
      description: 'Trigger trg_state_log_immutable must be enabled on transaction_state_log.',
      query: `
        SELECT tgname, relname, tgenabled
        FROM pg_trigger tg
        JOIN pg_class cl ON tg.tgrelid = cl.oid
        WHERE cl.relname = 'transaction_state_log' 
          AND tg.tgname = 'trg_state_log_immutable';
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q04',
      name: 'Composite Idempotency Uniqueness',
      description: 'Zero duplicate (merchant_id, operation, key) rows in idempotency_keys.',
      query: `
        SELECT merchant_id, operation, key, COUNT(*) as cnt
        FROM idempotency_keys
        GROUP BY merchant_id, operation, key
        HAVING COUNT(*) > 1;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q05',
      name: 'Single Active Attempt Invariant',
      description: 'No transaction may have more than one concurrent active attempt.',
      query: `
        SELECT transaction_id, COUNT(*) as active_cnt
        FROM payment_attempts
        WHERE status IN ('CREATED', 'SENT', 'UNKNOWN')
        GROUP BY transaction_id
        HAVING COUNT(*) > 1;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q06',
      name: 'Legal State Log Transitions',
      description: 'Zero identical from_state = to_state rows unless explicitly permitted.',
      query: `
        SELECT id, transaction_id, from_state, to_state, event
        FROM transaction_state_log
        WHERE event NOT IN ('REJECTED_TRANSITION', 'OUT_OF_ORDER_RESOLUTION', 'SETTLEMENT_INVESTIGATION_LOGGED')
          AND from_state = to_state
          AND from_state IS NOT NULL;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q07',
      name: 'No Stale Expired PROCESSING Keys',
      description: 'Zero idempotency keys in PROCESSING status past expiration.',
      query: `
        SELECT merchant_id, operation, key
        FROM idempotency_keys
        WHERE status = 'PROCESSING' AND expires_at < NOW();
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q08',
      name: 'Webhook Ingestion Deduplication',
      description: 'Zero duplicate (gateway, event_id) rows in processed_webhook_events.',
      query: `
        SELECT gateway, event_id, COUNT(*) as cnt
        FROM processed_webhook_events
        GROUP BY gateway, event_id
        HAVING COUNT(*) > 1;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q09',
      name: 'Zero Negative Monetary Values',
      description: 'All monetary fields must be non-negative integers.',
      query: `
        SELECT id, amount_minor, authorized_minor, captured_minor, refunded_minor
        FROM transactions
        WHERE amount_minor < 0 
           OR authorized_minor < 0 
           OR captured_minor < 0 
           OR refunded_minor < 0 
           OR reserved_refund_minor < 0;
      `,
      violationsFound: 0,
      passed: true
    },
    {
      id: 'Q10',
      name: 'Captures and Refunds Foreign Key Consistency',
      description: 'Zero dangling capture or refund records.',
      query: `
        SELECT c.id
        FROM capture_operations c
        LEFT JOIN transactions t ON c.transaction_id = t.id
        WHERE t.id IS NULL
        UNION ALL
        SELECT r.id
        FROM refunds r
        LEFT JOIN transactions t ON r.transaction_id = t.id
        WHERE t.id IS NULL;
      `,
      violationsFound: 0,
      passed: true
    }

  ];

  for (const check of checks) {
    const res = await pool.query(check.query);
    if (check.id === 'Q03') {
      // For Q03, we expect exactly 1 row confirming trigger is enabled ('O')
      const passed = res.rows.length === 1 && (res.rows[0].tgenabled === 'O' || res.rows[0].tgenabled === 'A');
      check.passed = passed;
      check.violationsFound = passed ? 0 : 1;
    } else {
      check.violationsFound = res.rows.length;
      check.passed = res.rows.length === 0;
      if (res.rows.length > 0) {
        check.sampleViolations = res.rows.slice(0, 5);
      }
    }

    console.log(`[${check.id}] ${check.name.padEnd(45)} -> ${check.passed ? '✅ PASSED (0 violations)' : `❌ FAILED (${check.violationsFound} violations)`}`);
  }

  const allPassed = checks.every((c) => c.passed);
  console.log(`\nIntegrity Result: ${allPassed ? '✅ 100% INVARIANTS SATISFIED' : '❌ VIOLATIONS DETECTED'}\n`);

  // Write Artifacts
  const artifactDir = path.resolve(process.cwd(), 'artifacts', 'part-b');
  fs.mkdirSync(artifactDir, { recursive: true });

  const jsonOut = path.join(artifactDir, 'integrity-audit.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ timestamp: new Date().toISOString(), allPassed, checks }, null, 2), 'utf8');

  let mdContent = `# Part B Financial & State Machine Integrity Audit\n\n`;
  mdContent += `**Executed At:** ${new Date().toISOString()}  \n`;
  mdContent += `**Audit Outcome:** ${allPassed ? '✅ 10/10 Invariants Satisfied (Zero Violations)' : '❌ Violations Detected'}  \n\n`;
  mdContent += `| Check ID | Invariant Description | Status | Violations |\n`;
  mdContent += `|---|---|---|---|\n`;

  for (const c of checks) {
    mdContent += `| \`${c.id}\` | **${c.name}**: ${c.description} | ${c.passed ? '✅ PASS' : '❌ FAIL'} | ${c.violationsFound} |\n`;
  }

  mdContent += `\n## SQL Invariant Definitions\n\n`;
  for (const c of checks) {
    mdContent += `### ${c.id}: ${c.name}\n`;
    mdContent += `\`\`\`sql\n${c.query.trim()}\n\`\`\`\n\n`;
  }

  const mdOut = path.join(artifactDir, 'integrity-audit.md');
  fs.writeFileSync(mdOut, mdContent, 'utf8');

  console.log(`Saved integrity audit artifacts:`);
  console.log(`  -> ${jsonOut}`);
  console.log(`  -> ${mdOut}`);
  console.log('================================================================');
}

runIntegrityAudit()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Integrity audit failed:', err);
    process.exit(1);
  });
