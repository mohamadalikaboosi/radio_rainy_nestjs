import { BadRequestException, Body, Controller, Get, Header, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { ZodPipe } from '../../shared/interface/zod.pipe';
import { AdsRepository } from '../application/ports/ads.repository';
import { PlatformSettingsRepository } from '../../accounts/application/ports/platform-settings.repository';
import { SponsorsRepository } from '../application/ports/sponsors.repository';
import { TagVoteService, VoteView } from '../application/tag-vote.service';
import { VoteLimitError } from '../application/ports/tag-poll.repository';

const voteBody = z.object({ voterId: z.string().min(8).max(64), hashtag: z.string().min(1).max(64) });

/** Public (unauthenticated) read/engage endpoints: sponsors, ad artwork, click redirects and the tag vote. */
@Controller('radio')
export class EngagementPublicController {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly sponsors: SponsorsRepository,
    private readonly ads: AdsRepository,
    private readonly votes: TagVoteService,
    private readonly platform: PlatformSettingsRepository,
  ) {}

  private async channelId(slug: string): Promise<string> {
    const c = await this.channels.bySlug(slug);
    if (!c) throw new NotFoundException('Unknown station');
    return c.id;
  }

  @Get(':slug/sponsors')
  @Header('Cache-Control', 'no-store')
  async activeSponsors(@Param('slug') slug: string) {
    const list = await this.sponsors.active(await this.channelId(slug));
    void this.sponsors.recordImpressions(list.map((s) => s.id)).catch(() => undefined);
    return list.map((s) => ({ id: s.id, name: s.name, tagline: s.tagline, ctaLabel: s.ctaLabel, weight: s.weight, logoUrl: s.hasLogo ? `/radio/sponsors/${s.id}/logo` : null, url: `/radio/go/sponsor/${s.id}` }));
  }

  @Get(':slug/vote')
  @Header('Cache-Control', 'no-store')
  async voteState(@Param('slug') slug: string, @Query('voterId') voterId?: string): Promise<VoteView> {
    return this.votes.view(await this.channelId(slug), voterId);
  }

  @Post(':slug/vote')
  @HttpCode(200)
  async vote(@Param('slug') slug: string, @Body(new ZodPipe(voteBody)) body: { voterId: string; hashtag: string }, @Req() req: Request): Promise<VoteView> {
    const id = await this.channelId(slug);
    try {
      return await this.votes.vote(id, body.voterId, req.ip ?? 'unknown', body.hashtag);
    } catch (err) {
      if (err instanceof VoteLimitError) throw new BadRequestException('Too many votes from this network');
      throw new BadRequestException(err instanceof Error ? err.message : 'Vote rejected');
    }
  }

  @Get('ads/:id/image')
  async adImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    this.sendImage(res, await this.ads.image(id));
  }

  @Get('sponsors/:id/logo')
  async sponsorLogo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    this.sendImage(res, await this.sponsors.logo(id));
  }

  @Get('go/ad/:id')
  async goAd(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const p = await this.platform.get();
    this.redirect(res, await this.ads.click(id, { enabled: p.billingEnabled, pricePerPlayCents: p.pricePerPlayCents, pricePerClickCents: p.pricePerClickCents }));
  }

  @Get('go/sponsor/:id')
  async goSponsor(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    this.redirect(res, await this.sponsors.click(id));
  }

  private sendImage(res: Response, img: { data: Buffer; mime: string } | null): void {
    if (!img) throw new NotFoundException();
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(img.data);
  }

  /** Only ever redirects to an http(s) URL an admin saved. */
  private redirect(res: Response, url: string | null): void {
    if (!url || !/^https?:\/\//i.test(url)) throw new NotFoundException();
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  }
}
