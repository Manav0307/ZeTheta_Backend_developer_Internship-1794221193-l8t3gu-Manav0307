import { PaymentGateway } from './gateway.interface.js';
import { RazorpayAdapter } from './razorpay.adapter.js';
import { StripeAdapter } from './stripe.adapter.js';
import { PayUAdapter } from './payu.adapter.js';
import { UpiAdapter } from './upi.adapter.js';
import { NotFoundError } from '../shared/errors/index.js';

export class GatewayRegistry {
  private static adapters: Map<string, PaymentGateway> = new Map<string, PaymentGateway>([
    ['razorpay', new RazorpayAdapter() as PaymentGateway],
    ['stripe', new StripeAdapter() as PaymentGateway],
    ['payu', new PayUAdapter() as PaymentGateway],
    ['upi', new UpiAdapter() as PaymentGateway]
  ]);

  static get(name: string): PaymentGateway {
    const adapter = this.adapters.get(name.toLowerCase());
    if (!adapter) {
      throw new NotFoundError(`Gateway adapter ${name} not found in registry`, 'GATEWAY_ADAPTER_NOT_FOUND');
    }
    return adapter;
  }

  static getAll(): PaymentGateway[] {
    return Array.from(this.adapters.values());
  }

  static has(name: string): boolean {
    return this.adapters.has(name.toLowerCase());
  }
}
