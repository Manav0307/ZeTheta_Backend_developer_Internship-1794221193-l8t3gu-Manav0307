import { getPool, closePool } from '../src/database/connection.js';
import { IntelligentRouter } from '../src/modules/routing/index.js';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const tx = await client.query(`
      INSERT INTO transactions (merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id)
      VALUES ('mer_test', 'ord_' || gen_random_uuid(), 'CARD', 'INR', 50000, $1)
      RETURNING id
    `, [uuidv4()]);

    const res = await IntelligentRouter.selectRoute(client, {
      transactionId: tx.rows[0].id,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      traceId: uuidv4()
    });
    console.log('Selected Gateway:', res.selectedGateway);
    console.table(res.candidateScores.map(c => ({
      gateway: c.gateway,
      score: c.score,
      success: c.raw_success_rate,
      p95: c.raw_p95_ms,
      cost: c.raw_cost_minor,
      health: c.health_score,
      state: c.breaker_state
    })));
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(console.error);
