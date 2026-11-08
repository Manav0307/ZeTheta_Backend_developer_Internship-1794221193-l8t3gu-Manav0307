export type MockSimulationBehavior =
  | 'success'
  | 'hard_decline'
  | 'definite_5xx'
  | 'timeout_before_execution'
  | 'timeout_after_execution'
  | 'delayed_success'
  | 'capture_failure'
  | 'refund_failure'
  | 'rate_limited';

export class MockGatewayController {
  private static behaviorMap: Map<string, MockSimulationBehavior> = new Map();
  private static mockLedger: Map<string, { status: string; amountMinor: string; gateway: string }> = new Map();

  static setBehavior(gateway: string, behavior: MockSimulationBehavior): void {
    this.behaviorMap.set(gateway.toLowerCase(), behavior);
  }

  static getBehavior(gateway: string): MockSimulationBehavior {
    return this.behaviorMap.get(gateway.toLowerCase()) || 'success';
  }

  static reset(gateway?: string): void {
    if (gateway) {
      this.behaviorMap.delete(gateway.toLowerCase());
    } else {
      this.behaviorMap.clear();
      this.mockLedger.clear();
    }
  }

  static recordCharge(ref: string, status: string, amountMinor: string, gateway: string): void {
    this.mockLedger.set(ref, { status, amountMinor, gateway });
  }

  static getCharge(ref: string): { status: string; amountMinor: string; gateway: string } | undefined {
    return this.mockLedger.get(ref);
  }
}

