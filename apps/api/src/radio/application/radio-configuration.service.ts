import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../administration/application/ports/audit.service';
import { normalizeHashtag } from '../../catalog/domain/caption-parser';
import { TransactionRunner, TxHandle } from '../../shared/kernel/transaction';
import { TrackRepository } from '../../catalog/application/ports/track.repository';
import { PlaybackHistoryRepository } from './ports/playback-history.repository';
import { RadioBus } from './ports/radio-bus';
import { RadioConfigRepository, RadioConfigWithMeta } from './ports/radio-config.repository';
import { RadioRuleEngine } from '../domain/radio-rule-engine';
import { RadioStateRepository } from './ports/radio-state.repository';
import { HashtagSelection, RADIO_MODES, RadioConfigSnapshot, RadioRuleSnapshot } from '../domain/radio.types';

const tag = z.string().min(1).max(100).transform((s) => normalizeHashtag(s.replace(/^#/, ''))).refine((s) => s.length > 0, 'empty hashtag');

export const configUpdateSchema = z.object({
  mode: z.enum(RADIO_MODES),
  hashtagMatchMode: z.enum(['ANY', 'ALL']),
  recentTrackWindow: z.number().int().min(0).max(10_000),
  fallbackToGlobal: z.boolean().default(true),
  enabled: z.boolean().default(true),
  hashtags: z.array(z.object({ hashtag: tag, weight: z.number().int().min(0).max(100_000).default(1) })).max(500).default([]),
  /** Optimistic concurrency: reject if someone else changed the configuration meanwhile. */
  expectedVersion: z.number().int().optional(),
  apply: z.enum(['NEXT_TRACK', 'IMMEDIATE']).default('NEXT_TRACK'),
});
export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(0).max(100_000),
  matchMode: z.enum(['ANY', 'ALL']).default('ANY'),
  weight: z.number().int().min(0).max(100_000).default(1),
  enabled: z.boolean().default(true),
  include: z.array(tag).min(1).max(100),
  exclude: z.array(tag).max(100).default([]),
});
export type RuleInput = z.infer<typeof ruleSchema>;

export const previewSchema = z.object({
  mode: z.enum(RADIO_MODES).optional(),
  hashtags: z.array(z.union([tag.transform((h) => ({ hashtag: h, weight: 1 })), z.object({ hashtag: tag, weight: z.number().int().min(0).default(1) })])).optional(),
  match: z.enum(['ANY', 'ALL']).optional(),
  recentTrackWindow: z.number().int().min(0).max(10_000).optional(),
  rules: z.array(ruleSchema).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  seed: z.number().int().optional(),
});
export type PreviewRequest = z.infer<typeof previewSchema>;

export interface ActorContext {
  actor: string;
  requestId?: string | null;
}

export interface ConfigView {
  version: number;
  mode: string;
  hashtagMatchMode: string;
  recentTrackWindow: number;
  fallbackToGlobal: boolean;
  enabled: boolean;
  hashtags: HashtagSelection[];
  rules: (RadioRuleSnapshot & { id: string })[];
}

/**
 * The only writer of radio configuration. Every change: one transaction that locks the config row
 * (atomic + serialized across admins/instances), bumps the version, writes an audit record, then notifies the leader.
 */
@Injectable()
export class RadioConfigurationService {
  constructor(
    private readonly db: TransactionRunner,
    private readonly repo: RadioConfigRepository,
    private readonly audit: AuditService,
    private readonly bus: RadioBus,
    private readonly state: RadioStateRepository,
    private readonly history: PlaybackHistoryRepository,
    private readonly tracks: Pick<TrackRepository, 'titlesOf'>,
    private readonly engine: RadioRuleEngine = new RadioRuleEngine(),
  ) {}

  async getConfig(channelId: string): Promise<ConfigView> {
    return this.view(await this.repo.getSnapshot(channelId));
  }

  private view(c: RadioConfigWithMeta): ConfigView {
    return {
      version: c.version,
      mode: c.snapshot.mode,
      hashtagMatchMode: c.snapshot.hashtagMatchMode,
      recentTrackWindow: c.snapshot.recentTrackWindow,
      fallbackToGlobal: c.snapshot.fallbackToGlobal,
      enabled: c.enabled,
      hashtags: [...c.snapshot.hashtags],
      rules: c.snapshot.rules.map((r) => ({ ...r })),
    };
  }

  async updateConfig(channelId: string, input: ConfigUpdate, ctx: ActorContext): Promise<ConfigView> {
    const after = await this.db.tx(async (q) => {
      await this.lockConfig(q, channelId, input.expectedVersion);
      const before = this.view(await this.repo.getSnapshot(channelId, q));
      const ids = await this.resolveHashtagIds(q, input.hashtags.map((h) => h.hashtag));
      await this.repo.updateSettings(q, channelId, input, ctx.actor);
      await this.repo.replaceHashtagSelection(q, channelId, input.hashtags.flatMap((h) => {
        const id = ids.get(h.hashtag);
        return id ? [{ hashtagId: id, weight: h.weight }] : [];
      }));
      const after = this.view(await this.repo.getSnapshot(channelId, q));
      await this.audit.record({ actor: ctx.actor, action: 'radio.config.update', entityType: 'radio_configuration', entityId: channelId, before, after: { ...after, apply: input.apply }, requestId: ctx.requestId }, q);
      return after;
    });
    await this.bus.publish({ type: 'config-changed', channelId });
    if (input.apply === 'IMMEDIATE') await this.bus.publish({ type: 'play-next', channelId });
    return after;
  }

  // ---- rules ----

  async createRule(channelId: string, input: RuleInput, ctx: ActorContext): Promise<ConfigView['rules'][number]> {
    return this.mutateRules(channelId, ctx, 'radio.rule.create', async (q) => {
      const ids = await this.resolveHashtagIds(q, [...input.include, ...input.exclude]);
      const id = await this.repo.insertRule(q, channelId, input);
      await this.repo.replaceRuleHashtags(q, id, this.ruleTags(input, ids));
      return { id, before: null };
    });
  }

  async updateRule(channelId: string, id: string, input: RuleInput, ctx: ActorContext): Promise<ConfigView['rules'][number]> {
    return this.mutateRules(channelId, ctx, 'radio.rule.update', async (q) => {
      const before = (await this.repo.getSnapshot(channelId, q)).snapshot.rules.find((r) => r.id === id);
      if (!before) throw new NotFoundException('Rule not found');
      const ids = await this.resolveHashtagIds(q, [...input.include, ...input.exclude]);
      await this.repo.updateRule(q, channelId, id, input);
      await this.repo.replaceRuleHashtags(q, id, this.ruleTags(input, ids));
      return { id, before };
    });
  }

  async deleteRule(channelId: string, id: string, ctx: ActorContext): Promise<void> {
    await this.db.tx(async (q) => {
      await this.lockConfig(q, channelId);
      const before = (await this.repo.getSnapshot(channelId, q)).snapshot.rules.find((r) => r.id === id);
      if (!before) throw new NotFoundException('Rule not found');
      await this.repo.deleteRule(q, channelId, id);
      await this.repo.bumpVersion(q, channelId, ctx.actor);
      await this.audit.record({ actor: ctx.actor, action: 'radio.rule.delete', entityType: 'radio_rule', entityId: id, before, requestId: ctx.requestId }, q);
    });
    await this.bus.publish({ type: 'config-changed', channelId });
  }

  private async mutateRules(
    channelId: string,
    ctx: ActorContext,
    action: string,
    fn: (q: TxHandle) => Promise<{ id: string; before: RadioRuleSnapshot | null }>,
  ): Promise<ConfigView['rules'][number]> {
    const out = await this.db.tx(async (q) => {
      await this.lockConfig(q, channelId);
      const { id, before } = await fn(q);
      await this.repo.bumpVersion(q, channelId, ctx.actor);
      const after = (await this.repo.getSnapshot(channelId, q)).snapshot.rules.find((r) => r.id === id);
      if (!after) throw new NotFoundException('Rule not found');
      await this.audit.record({ actor: ctx.actor, action, entityType: 'radio_rule', entityId: id, before, after, requestId: ctx.requestId }, q);
      return after;
    });
    await this.bus.publish({ type: 'config-changed', channelId });
    return out;
  }

  private ruleTags(input: RuleInput, ids: Map<string, string>): { hashtagId: string; kind: 'INCLUDE' | 'EXCLUDE' }[] {
    const out: { hashtagId: string; kind: 'INCLUDE' | 'EXCLUDE' }[] = [];
    for (const [kind, tags] of [['INCLUDE', input.include], ['EXCLUDE', input.exclude]] as const) {
      for (const t of new Set(tags)) {
        const hashtagId = ids.get(t);
        if (hashtagId) out.push({ hashtagId, kind });
      }
    }
    return out;
  }

  /** Row lock on the singleton config: concurrent admin writes queue up instead of interleaving. */
  private async lockConfig(q: TxHandle, channelId: string, expectedVersion?: number): Promise<number> {
    const version = await this.repo.lock(q, channelId);
    if (version === null) throw new NotFoundException('Channel not found');
    if (expectedVersion !== undefined && expectedVersion !== version) {
      throw new ConflictException({ message: 'Radio configuration was changed by someone else', currentVersion: version });
    }
    return version;
  }

  private async resolveHashtagIds(q: TxHandle, tags: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(tags)];
    const map = await this.repo.hashtagIds(q, unique);
    const unknown = unique.filter((t) => !map.has(t));
    if (unknown.length > 0) throw new BadRequestException({ message: 'Unknown hashtags', unknown });
    return map;
  }

  // ---- preview (same RadioRuleEngine as the live radio) ----

  async preview(channelId: string, req: PreviewRequest): Promise<{
    seed: number;
    mode: string;
    eligibleCount: number;
    tracks: { id: string; title: string; artist: string | null; hashtags: string[]; reason: string }[];
  }> {
    const cur = await this.repo.getSnapshot(channelId);
    const draftRules: RadioRuleSnapshot[] | undefined = req.rules?.map((r, i) => ({ id: `draft-${i}`, name: r.name, priority: r.priority, matchMode: r.matchMode, weight: r.weight, enabled: r.enabled, include: r.include, exclude: r.exclude }));
    const snapshot: RadioConfigSnapshot = {
      ...cur.snapshot,
      mode: req.mode ?? cur.snapshot.mode,
      hashtagMatchMode: req.match ?? cur.snapshot.hashtagMatchMode,
      recentTrackWindow: req.recentTrackWindow ?? cur.snapshot.recentTrackWindow,
      hashtags: req.hashtags ?? cur.snapshot.hashtags,
      rules: draftRules ?? cur.snapshot.rules,
    };
    const seed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
    const [candidates, st] = await Promise.all([this.repo.loadCandidates(channelId), this.state.get(channelId)]);
    const recent = await this.history.recentTrackIds(channelId, Math.max(snapshot.recentTrackWindow, 1));
    const recentIds = st.currentTrackId ? [st.currentTrackId, ...recent.filter((id) => id !== st.currentTrackId)] : recent;
    const result = this.engine.preview({ config: snapshot, candidates, recentTrackIds: recentIds, rotationCursor: st.rotationCursor }, req.limit, seed);

    const ids = [...new Set(result.trackIds)];
    const meta = await this.tracks.titlesOf(ids);
    const byId = new Map(meta.map((m) => [m.id, m]));
    const tagsById = new Map(candidates.map((c) => [c.id, c.hashtags]));
    return {
      seed,
      mode: snapshot.mode,
      eligibleCount: result.eligibleCount,
      tracks: result.steps.filter((s) => s.trackId).map((s) => ({ id: s.trackId as string, title: byId.get(s.trackId as string)?.title ?? '', artist: byId.get(s.trackId as string)?.artist ?? null, hashtags: [...(tagsById.get(s.trackId as string) ?? [])], reason: s.reason })),
    };
  }
}
