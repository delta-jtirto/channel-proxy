import type { Channel, InboundAdapter, OutboundAdapter } from './types';

class AdapterRegistry {
  private inbound = new Map<Channel, InboundAdapter>();
  private outbound = new Map<Channel, OutboundAdapter>();

  register(inbound: InboundAdapter, outbound: OutboundAdapter) {
    if (inbound.channel !== outbound.channel) {
      throw new Error(
        `Channel mismatch: inbound=${inbound.channel}, outbound=${outbound.channel}`,
      );
    }
    this.inbound.set(inbound.channel, inbound);
    this.outbound.set(outbound.channel, outbound);
  }

  getInbound(channel: Channel): InboundAdapter | undefined {
    return this.inbound.get(channel);
  }

  getOutbound(channel: Channel): OutboundAdapter | undefined {
    return this.outbound.get(channel);
  }

  listChannels(): Channel[] {
    return [...this.inbound.keys()];
  }
}

// Singleton registry
export const registry = new AdapterRegistry();

// Register adapters — import this module to trigger registration
export function registerAllAdapters() {
  // Lazy imports to avoid circular deps and to only load what's needed
  // Each adapter self-registers when imported
}
