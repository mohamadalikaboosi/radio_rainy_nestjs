import { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PlaybackSupervisor } from './playback-supervisor';

export class PlaybackRunner implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(private readonly supervisor: PlaybackSupervisor) {}
  onApplicationBootstrap(): void {
    this.supervisor.start();
  }
  async onModuleDestroy(): Promise<void> {
    await this.supervisor.stop();
  }
  get isLeader(): boolean {
    return this.supervisor.isLeader;
  }
}
