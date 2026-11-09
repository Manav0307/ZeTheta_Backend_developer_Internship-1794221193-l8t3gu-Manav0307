import { MockResponseType } from './mock-control.js';

export interface MockPaymentRecord {
  providerReference: string;
  gateway: string;
  amountMinor: string;
  currency: string;
  status: 'AUTHORISED' | 'CAPTURED' | 'VOIDED' | 'REFUNDED' | 'FAILED' | 'EXPIRED';
  capturedMinor: string;
  refundedMinor: string;
  orderId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MockSettlementRecord {
  providerReference: string;
  gateway: string;
  amountMinor: string;
  settled: boolean;
  settlementDate: string;
  status: 'SETTLED' | 'FAILED' | 'REVERSED' | 'PENDING';
}

export class MockStateStore {
  private static payments: Map<string, MockPaymentRecord> = new Map();
  private static settlements: Map<string, MockSettlementRecord> = new Map();
  private static gatewayOverrides: Map<string, { responseMode?: MockResponseType; isDown?: boolean; delayMs?: number }> = new Map();
  private static scenarioState: Map<string, any> = new Map();

  static setGatewayOverride(gateway: string, override: { responseMode?: MockResponseType; isDown?: boolean; delayMs?: number }): void {
    this.gatewayOverrides.set(gateway.toLowerCase(), override);
  }

  static getGatewayOverride(gateway: string) {
    return this.gatewayOverrides.get(gateway.toLowerCase());
  }

  static recordPayment(payment: MockPaymentRecord): void {
    this.payments.set(payment.providerReference, payment);
  }

  static getPayment(providerReference: string): MockPaymentRecord | undefined {
    return this.payments.get(providerReference);
  }

  static updatePaymentStatus(providerReference: string, status: MockPaymentRecord['status'], capturedMinor?: string, refundedMinor?: string): MockPaymentRecord | undefined {
    const payment = this.payments.get(providerReference);
    if (payment) {
      payment.status = status;
      if (capturedMinor !== undefined) payment.capturedMinor = capturedMinor;
      if (refundedMinor !== undefined) payment.refundedMinor = refundedMinor;
      payment.updatedAt = Date.now();
      this.payments.set(providerReference, payment);
    }
    return payment;
  }

  static recordSettlement(settlement: MockSettlementRecord): void {
    this.settlements.set(settlement.providerReference, settlement);
  }

  static getSettlement(providerReference: string): MockSettlementRecord | undefined {
    return this.settlements.get(providerReference);
  }

  static getAllSettlements(gateway?: string): MockSettlementRecord[] {
    const all = Array.from(this.settlements.values());
    if (gateway) {
      return all.filter((s) => s.gateway.toLowerCase() === gateway.toLowerCase());
    }
    return all;
  }

  static setScenarioParam(key: string, value: any): void {
    this.scenarioState.set(key, value);
  }

  static getScenarioParam<T = any>(key: string): T | undefined {
    return this.scenarioState.get(key);
  }

  static reset(): void {
    this.payments.clear();
    this.settlements.clear();
    this.gatewayOverrides.clear();
    this.scenarioState.clear();
  }
}

