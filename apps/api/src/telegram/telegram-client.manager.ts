import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SettingsService, TelegramCredentials } from '../settings/settings.service';
import { withTimeout } from '../common/timeout';
import { withFloodWait } from './flood-wait';
import { maskPhone, TelegramSessionStore } from './telegram-session.store';
import { TelegramNotReadyError } from './telegram.types';

export type TelegramAuthState =
  | 'NOT_CONFIGURED'
  | 'NOT_LOGGED_IN'
  | 'CONNECTING'
  | 'AWAITING_CODE'
  | 'AWAITING_PASSWORD'
  | 'READY'
  | 'DISCONNECTED'
  | 'ERROR';

export interface TelegramStatus {
  state: TelegramAuthState;
  accountLabel: string | null;
  error?: string;
}

interface PendingLogin {
  client: TelegramClient;
  creds: TelegramCredentials;
  phone: string;
  phoneCodeHash: string;
  actor: string;
  expiresAt: number;
}

const LOGIN_TTL_MS = 5 * 60_000;
const LOGIN_STEP_TIMEOUT_MS = 30_000;

/** Owns the MTProto client: session load, reconnect supervision and the interactive (admin panel) login flow. */
@Injectable()
export class TelegramClientManager implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramClientManager.name);
  private client: TelegramClient | null = null;
  private state: TelegramAuthState = 'NOT_CONFIGURED';
  private unsubscribeSettings: (() => void) | null = null;
  private lastError: string | undefined;
  private accountLabel: string | null = null;
  private pending: PendingLogin | null = null;
  private supervisor: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'TELEGRAM_SESSION'>,
    private readonly store: TelegramSessionStore,
    private readonly settings: Pick<SettingsService, 'telegram' | 'onChange'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Never block/crash boot on Telegram: the radio can run from already-synced tracks.
    void this.start().catch((err: unknown) => this.logger.error({ msg: 'telegram start failed', err: this.safeError(err) }));
    this.supervisor = setInterval(() => void this.supervise(), 30_000);
    this.supervisor.unref();
    // API id/hash edited in the panel: reconnect with the new credentials.
    this.unsubscribeSettings = this.settings.onChange((section) => {
      if (section === 'telegram') void this.restart().catch((err: unknown) => this.logger.error({ msg: 'telegram restart failed', err: this.safeError(err) }));
    });
  }

  async restart(): Promise<void> {
    await this.cancelLogin();
    await this.disconnect();
    this.state = 'NOT_CONFIGURED';
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeSettings?.();
    if (this.supervisor) clearInterval(this.supervisor);
    await this.disconnect();
  }

  getStatus(): TelegramStatus {
    return { state: this.state, accountLabel: this.accountLabel, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** The authorized client, or throws TelegramNotReadyError. */
  getClient(): TelegramClient {
    if (this.state !== 'READY' || !this.client) throw new TelegramNotReadyError();
    return this.client;
  }

  isReady(): boolean {
    return this.state === 'READY' && this.client !== null;
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const creds = await this.settings.telegram();
    if (!creds) {
      this.state = 'NOT_CONFIGURED';
      this.logger.warn({ msg: 'telegram API id/hash not set; configure them in the admin panel' });
      return;
    }
    let session = await this.store.load();
    if (!session && this.config.TELEGRAM_SESSION) {
      session = this.config.TELEGRAM_SESSION;
      await this.store.save(session, null, 'env-bootstrap');
      this.logger.log({ msg: 'imported TELEGRAM_SESSION from env into encrypted store' });
    }
    if (!session) {
      this.state = 'NOT_LOGGED_IN';
      this.logger.warn({ msg: 'telegram not logged in; use the admin panel to log in' });
      return;
    }
    this.state = 'CONNECTING';
    const client = this.newClient(session, creds);
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        await client.disconnect();
        this.state = 'NOT_LOGGED_IN';
        this.lastError = 'Stored session is no longer authorized; please log in again';
        this.logger.warn({ msg: this.lastError });
        return;
      }
      this.client = client;
      this.state = 'READY';
      this.lastError = undefined;
      const info = await this.store.info();
      this.accountLabel = info?.accountLabel ?? null;
      this.logger.log({ msg: 'telegram connected' });
    } catch (err) {
      this.state = 'DISCONNECTED';
      this.lastError = this.safeError(err);
      this.logger.error({ msg: 'telegram connect failed', err: this.lastError });
    }
  }

  private newClient(session: string, creds: TelegramCredentials): TelegramClient {
    return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
      connectionRetries: 10,
      autoReconnect: true,
      floodSleepThreshold: 20,
      useWSS: false,
    });
  }

  private async supervise(): Promise<void> {
    if (this.pending && this.pending.expiresAt < Date.now()) await this.cancelLogin();
    if (this.state === 'READY' && this.client && !this.client.connected) {
      this.logger.warn({ msg: 'telegram connection lost; reconnecting' });
      try {
        await this.client.connect();
      } catch (err) {
        this.state = 'DISCONNECTED';
        this.lastError = this.safeError(err);
      }
    } else if (this.state === 'DISCONNECTED') {
      await this.start().catch((err: unknown) => this.logger.error({ msg: 'reconnect failed', err: this.safeError(err) }));
    }
  }

  // ---- interactive login (Super Admin panel) ----

  async beginLogin(phone: string, actor: string): Promise<void> {
    await this.cancelLogin();
    const creds = await this.settings.telegram();
    if (!creds) throw new TelegramNotReadyError('Set the Telegram API ID and API hash first (Settings page)');
    const client = this.newClient('', creds);
    try {
      await withTimeout(client.connect(), LOGIN_STEP_TIMEOUT_MS, 'Connecting to Telegram');
      const { phoneCodeHash } = await withTimeout(
        withFloodWait('sendCode', () => client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone)),
        LOGIN_STEP_TIMEOUT_MS,
        'Requesting the login code',
      );
      this.pending = { client, creds, phone, phoneCodeHash, actor, expiresAt: Date.now() + LOGIN_TTL_MS };
      this.state = 'AWAITING_CODE';
      this.logger.log({ msg: 'telegram login code requested', phone: maskPhone(phone), actor });
    } catch (err) {
      await client.disconnect().catch((e: unknown) => this.logger.warn({ msg: 'disconnect failed', err: String(e) }));
      throw err;
    }
  }

  /** Returns 'READY' or 'AWAITING_PASSWORD' (2FA enabled). Wrong code throws. */
  async submitCode(code: string): Promise<'READY' | 'AWAITING_PASSWORD'> {
    const p = this.requirePending();
    try {
      await withTimeout(p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: code })), LOGIN_STEP_TIMEOUT_MS, 'Verifying the code');
    } catch (err) {
      if (this.rpcMessage(err) === 'SESSION_PASSWORD_NEEDED') {
        this.state = 'AWAITING_PASSWORD';
        return 'AWAITING_PASSWORD';
      }
      throw err;
    }
    await this.finishLogin(p);
    return 'READY';
  }

  async submitPassword(password: string): Promise<void> {
    const p = this.requirePending();
    let inner: unknown;
    try {
      await p.client.signInWithPassword(
        { apiId: p.creds.apiId, apiHash: p.creds.apiHash },
        {
          password: async () => password,
          onError: async (e: Error) => {
            inner = e;
            return true; // stop retrying; surface the error to the admin
          },
        },
      );
    } catch (err) {
      throw inner ?? err;
    }
    await this.finishLogin(p);
  }

  private async finishLogin(p: PendingLogin): Promise<void> {
    const session = (p.client.session as StringSession).save();
    const label = maskPhone(p.phone);
    await this.store.save(session, label, p.actor); // encrypted at rest
    await this.disconnect();
    this.pending = null;
    this.client = p.client;
    this.state = 'READY';
    this.accountLabel = label;
    this.lastError = undefined;
    this.logger.log({ msg: 'telegram login completed', actor: p.actor, account: label });
  }

  async cancelLogin(): Promise<void> {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    if (this.client !== p.client) await p.client.disconnect().catch((e: unknown) => this.logger.warn({ msg: 'disconnect failed', err: String(e) }));
    if (this.state === 'AWAITING_CODE' || this.state === 'AWAITING_PASSWORD') this.state = this.client ? 'READY' : 'NOT_LOGGED_IN';
  }

  async logout(): Promise<void> {
    await this.cancelLogin();
    const client = this.client;
    if (client) {
      await client.invoke(new Api.auth.LogOut()).catch((e: unknown) => this.logger.warn({ msg: 'remote logout failed', err: this.safeError(e) }));
    }
    await this.disconnect();
    await this.store.clear();
    this.state = 'NOT_LOGGED_IN';
    this.accountLabel = null;
  }

  private async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.disconnect().catch((e: unknown) => this.logger.warn({ msg: 'disconnect failed', err: String(e) }));
  }

  private requirePending(): PendingLogin {
    if (!this.pending || this.pending.expiresAt < Date.now()) throw new TelegramNotReadyError('No login in progress (or it expired); start again');
    return this.pending;
  }

  private rpcMessage(err: unknown): string {
    return typeof err === 'object' && err !== null && 'errorMessage' in err ? String((err as { errorMessage: unknown }).errorMessage) : '';
  }

  /** Error text that can never contain the session/hash (they are not part of GramJS error messages). */
  private safeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
