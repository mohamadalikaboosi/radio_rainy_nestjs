import { z } from 'zod';

/**
 * Tiny "something changed" hints that travel over Redis pub/sub between instances. They carry no heavy payload:
 * every instance builds the actual message from the database for the sockets IT holds, so all instances agree and
 * a listener can connect to any of them.
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  /** The track / ad on air changed (published by the leader's engine). */
  z.object({ type: z.literal('current'), channelId: z.string() }),
  /** The tag vote opened, closed, changed its winner or received a vote. */
  z.object({ type: z.literal('vote'), channelId: z.string() }),
  /** An announcement was posted or removed. */
  z.object({ type: z.literal('messages'), channelId: z.string() }),
  /** Audio-stream listeners of a station (only the leader knows them). */
  z.object({ type: z.literal('listeners'), channelId: z.string(), count: z.number().int().min(0) }),
  /** How many WebSocket clients one instance holds for a station (summed over instances for the "clients" number). */
  z.object({ type: z.literal('clients'), channelId: z.string(), instance: z.string(), count: z.number().int().min(0) }),
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>>;
}

export const REALTIME_BUS = Symbol('REALTIME_BUS');
