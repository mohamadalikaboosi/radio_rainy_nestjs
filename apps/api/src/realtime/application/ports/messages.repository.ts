import { z } from 'zod';

export const messageSchema = z.object({
  text: z.string().trim().min(1).max(500),
  level: z.enum(['INFO', 'WARN']).default('INFO'),
  /** How long listeners see it. */
  minutes: z.number().int().min(1).max(1440).default(10),
});

export interface LiveMessage {
  id: string;
  channelId: string;
  text: string;
  level: 'INFO' | 'WARN';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export type MessageInput = z.infer<typeof messageSchema>;

export abstract class MessagesRepository {
  abstract create(channelId: string, input: MessageInput, by: string): Promise<LiveMessage>;
  /** Messages listeners should see right now (newest first). */
  abstract active(channelId: string): Promise<LiveMessage[]>;
  abstract remove(channelId: string, id: string): Promise<boolean>;
  /** Housekeeping: old rows are useless once expired. */
  abstract purgeExpired(): Promise<void>;
}
