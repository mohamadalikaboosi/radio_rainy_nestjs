import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigError, loadConfig, redactConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  // Validate the environment before anything starts: never run half-configured.
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.enableCors({ origin: true, credentials: false });
  await app.listen(cfg.PORT, '0.0.0.0');
  app.get(Logger).log({ msg: 'radio_rainy started', port: cfg.PORT, config: redactConfig(cfg) });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
