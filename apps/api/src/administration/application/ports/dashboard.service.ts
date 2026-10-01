export abstract class DashboardService {
  /** All stations at a glance + global counts. */
  abstract overview(): Promise<unknown>;
  abstract channel(channelId: string): Promise<unknown>;
}
