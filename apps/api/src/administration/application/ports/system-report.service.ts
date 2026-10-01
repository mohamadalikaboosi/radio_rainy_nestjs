/** Health of every moving part in one place (queues, Telegram, stations, integrations, cache). */
export abstract class SystemReportService {
  abstract get(): Promise<unknown>;
}
