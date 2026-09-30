import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigError, loadConfig, redactConfig } from './config/app-config';

const API_PREFIXES = ['/admin', '/radio'];

async function bootstrap(): Promise<void> {
  // Validate the environment before anything starts: never run half-configured.
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.enableCors({ origin: true, credentials: false });

  // Serve the built admin panel + public player from the same process (single deployable).
  const uiDir = resolve(cfg.ADMIN_UI_DIR ?? join(__dirname, '..', '..', 'admin', 'dist'));
  const index = join(uiDir, 'index.html');
  if (existsSync(index)) {
    app.useStaticAssets(uiDir, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isApi = API_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`));
      if (req.method !== 'GET' || isApi || req.path.includes('.')) return next();
      res.sendFile(index);
    });
  }

  await app.listen(cfg.PORT, '0.0.0.0');
  app.get(Logger).log({ msg: 'radio_rainy started', port: cfg.PORT, ui: existsSync(index) ? uiDir : 'not built', config: redactConfig(cfg) });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
