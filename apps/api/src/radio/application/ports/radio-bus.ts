import { z } from 'zod';

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('skip'), channelId: z.string(), expectedSeq: z.number().int().optional() }),
  z.object({ type: z.literal('play-next'), channelId: z.string(), trackId: z.string().uuid().optional() }),
  /** Plays this track right after the current one finishes (no cut). */
  z.object({ type: z.literal('queue-next'), channelId: z.string(), trackId: z.string().uuid() }),
  z.object({ type: z.literal('config-changed'), channelId: z.string() }),
  z.object({ type: z.literal('wake'), channelId: z.string() }),
  /** Stations were added/removed/started/stopped or live streaming toggled: the leader reconciles. */
  z.object({ type: z.literal('stations-changed') }),
]);

export type RadioCommand = z.infer<typeof commandSchema>;

/** Admin requests may land on any instance; only the leader runs the engine, so commands travel over pub/sub. */
export interface RadioBus {
  publish(cmd: RadioCommand): Promise<void>;
  subscribe(handler: (cmd: RadioCommand) => void): Promise<() => Promise<void>>;
}

export const RADIO_BUS = Symbol('RADIO_BUS');
