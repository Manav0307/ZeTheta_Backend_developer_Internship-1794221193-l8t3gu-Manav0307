import { Request, Response, NextFunction } from 'express';
import { ReconciliationService } from '../../modules/reconciliation/reconciliation.service.js';

export class ReconciliationController {
  static async trigger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const staleMinutes = req.body?.stale_minutes ? parseInt(req.body.stale_minutes, 10) : undefined;
      const result = await ReconciliationService.triggerRun('MANUAL', staleMinutes);
      res.status(202).json({
        message: 'Reconciliation run initiated successfully',
        run_id: result.runId,
        status: result.status,
        scanned_count: result.scannedCount,
        mismatch_count: result.mismatchCount
      });
    } catch (err) {
      next(err);
    }
  }

  static async getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const run_id = Array.isArray(req.params.run_id) ? req.params.run_id[0] : req.params.run_id;
      const report = await ReconciliationService.getReport(run_id);
      res.status(200).json({ report });
    } catch (err) {
      next(err);
    }
  }

  static async reconcileSettlements(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const settlementRecords = req.body?.settlement_records || req.body?.settlements || [];
      const transactionIds = req.body?.transaction_ids;
      const result = await ReconciliationService.reconcileSettlementBatch({
        settlementFileRecords: settlementRecords,
        transactionIds,
        triggerSource: 'MANUAL'
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

