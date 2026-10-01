import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PlaybackHistoryRepository } from '../infrastructure/playback-history.repository';
import { RadioBus } from '../infrastructure/radio-bus';
import { ActorContext } from './radio-configuration.service';
import { RadioStateRepository } from '../infrastructure/radio-state.repository';
import { TrackRepository } from '../../catalog/infrastructure/persistence/track.repository';
import { AuditService } from '../../administration/application/audit.service';

/**
 * Admin playback controls. They only publish commands: the leader's PlaybackEngine executes them one at a time,
 * so skip / play-next can never start two simultaneous transitions, however many admins click.
 */
@Injectable()
export class RadioControlService {
  constructor(
    private readonly bus: RadioBus,
    private readonly audit: AuditService,
    private readonly tracks: TrackRepository,
    private readonly state: RadioStateRepository,
    private readonly history: PlaybackHistoryRepository,
  ) {}

  async skip(channelId: string, expectedSeq: number | undefined, ctx: ActorContext): Promise<{ accepted: true; transitionSeq: number }> {
    const st = await this.state.get(channelId);
    await this.bus.publish({ type: 'skip', channelId, ...(expectedSeq !== undefined ? { expectedSeq } : {}) });
    await this.audit.record({ actor: ctx.actor, action: 'radio.skip', entityType: 'radio', entityId: channelId, after: { expectedSeq, currentTrackId: st.currentTrackId }, requestId: ctx.requestId });
    return { accepted: true, transitionSeq: st.transitionSeq };
  }

  async playNext(channelId: string, trackId: string | undefined, ctx: ActorContext): Promise<{ accepted: true }> {
    if (trackId) {
      const t = await this.tracks.findById(trackId);
      if (!t) throw new NotFoundException('Track not found');
      if (t.telegramChannelId !== channelId) throw new BadRequestException('Track belongs to another channel');
      if (t.status !== 'READY' || !t.enabled) throw new BadRequestException('Track is not playable (disabled, failed or unavailable)');
    }
    await this.bus.publish({ type: 'play-next', channelId, ...(trackId ? { trackId } : {}) });
    await this.audit.record({ actor: ctx.actor, action: 'radio.play-next', entityType: 'radio', entityId: channelId, after: { specificTrack: Boolean(trackId) }, requestId: ctx.requestId });
    return { accepted: true };
  }

  /** Play `trackId` after the current track ends (unlike play-next it does not cut the current one). */
  async queueNext(channelId: string, trackId: string, ctx: ActorContext): Promise<{ accepted: true }> {
    const t = await this.tracks.findById(trackId);
    if (!t) throw new NotFoundException('Track not found');
    if (t.telegramChannelId !== channelId) throw new BadRequestException('Track belongs to another channel');
    if (t.status !== 'READY' || !t.enabled) throw new BadRequestException('Track is not playable (disabled, failed or unavailable)');
    await this.bus.publish({ type: 'queue-next', channelId, trackId });
    await this.audit.record({ actor: ctx.actor, action: 'radio.queue-next', entityType: 'radio', entityId: channelId, after: { trackId, title: t.title }, requestId: ctx.requestId });
    return { accepted: true };
  }

  historyList(channelId: string, limit: number): ReturnType<PlaybackHistoryRepository['list']> {
    return this.history.list(channelId, limit);
  }
}
