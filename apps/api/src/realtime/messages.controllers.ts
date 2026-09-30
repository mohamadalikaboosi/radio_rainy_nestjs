import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, AdminRequest } from '../admin/admin.guard';
import { AuditService } from '../admin/audit.service';
import { ChannelRepository } from '../channels/channel.repository';
import { ZodPipe } from '../common/zod.pipe';
import { REALTIME_BUS, RealtimeBus } from './events';
import { MessageInput, MessagesRepository, messageSchema } from './messages.repository';

const ChannelIdPipe = new ZodPipe(z.string().regex(/^\d{1,20}$/, 'invalid channel id'));

/** Announcements shown live to everyone listening to a station. The operator can post to any station. */
@Controller('admin/channels/:channelId/messages')
@UseGuards(AdminGuard)
export class AdminMessagesController {
  constructor(
    private readonly messages: MessagesRepository,
    private readonly channels: ChannelRepository,
    private readonly audit: AuditService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  @Get()
  async list(@Param('channelId', ChannelIdPipe) id: string) {
    return this.messages.active(id);
  }

  @Post()
  async create(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(messageSchema)) body: MessageInput, @Req() req: AdminRequest) {
    if (!(await this.channels.get(id))) throw new NotFoundException('Channel not found');
    const m = await this.messages.create(id, body, req.admin.email);
    await this.audit.record({ actor: req.admin.email, action: 'message.create', entityType: 'channel', entityId: id, after: { text: m.text, level: m.level, minutes: body.minutes }, requestId: req.id === undefined ? null : String(req.id) });
    await this.bus.publish({ type: 'messages', channelId: id });
    return m;
  }

  @Delete(':messageId')
  @HttpCode(204)
  async remove(@Param('channelId', ChannelIdPipe) id: string, @Param('messageId', ParseUUIDPipe) messageId: string, @Req() req: AdminRequest): Promise<void> {
    if (!(await this.messages.remove(id, messageId))) throw new NotFoundException('Unknown message');
    await this.audit.record({ actor: req.admin.email, action: 'message.delete', entityType: 'channel', entityId: id, requestId: req.id === undefined ? null : String(req.id) });
    await this.bus.publish({ type: 'messages', channelId: id });
  }
}
