import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

export interface LiveMessage {
  id: string;
  channelId: string;
  text: string;
  level: 'INFO' | 'WARN';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export const messageSchema = z.object({
  text: z.string().trim().min(1).max(500),
  level: z.enum(['INFO', 'WARN']).default('INFO'),
  /** How long listeners see it. */
  minutes: z.number().int().min(1).max(1440).default(10),
});
export type MessageInput = z.infer<typeof messageSchema>;

interface Row {
  id: string;
  channel_id: string;
  text: string;
  level: 'INFO' | 'WARN';
  created_by: string;
  created_at: Date;
  expires_at: Date;
}
const map = (r: Row): LiveMessage => ({ id: r.id, channelId: r.channel_id, text: r.text, level: r.level, createdBy: r.created_by, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() });

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(channelId: string, input: MessageInput, by: string): Promise<LiveMessage> {
    const r = await this.db.query<Row>(
      `INSERT INTO live_messages (channel_id, text, level, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) RETURNING *`,
      [channelId, input.text, input.level, by, String(input.minutes)],
    );
    return map(r.rows[0] as Row);
  }

  /** Messages listeners should see right now (newest first). */
  async active(channelId: string): Promise<LiveMessage[]> {
    const r = await this.db.query<Row>('SELECT * FROM live_messages WHERE channel_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 5', [channelId]);
    return r.rows.map(map);
  }

  async remove(channelId: string, id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM live_messages WHERE id = $1 AND channel_id = $2', [id, channelId])).rowCount ?? 0) > 0;
  }

  /** Housekeeping: old rows are useless once expired. */
  async purgeExpired(): Promise<void> {
    await this.db.query(`DELETE FROM live_messages WHERE expires_at < now() - interval '1 day'`);
  }
}
