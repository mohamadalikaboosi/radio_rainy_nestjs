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

/** What the rest of the app needs from the Telegram account connection (login flow + status); GramJS stays behind it. */
export abstract class TelegramConnection {
  abstract getStatus(): TelegramStatus;
  abstract isReady(): boolean;
  abstract restart(): Promise<void>;
  abstract beginLogin(phone: string, actor: string): Promise<void>;
  abstract submitCode(code: string): Promise<'READY' | 'AWAITING_PASSWORD'>;
  abstract submitPassword(password: string): Promise<void>;
  abstract cancelLogin(): Promise<void>;
  abstract logout(): Promise<void>;
}
