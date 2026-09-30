import { ConfigError, isWhisperEnabled, loadConfig, redactConfig } from './app-config';

const valid = {
  TELEGRAM_API_ID: '123',
  TELEGRAM_API_HASH: 'hash',
  TELEGRAM_SESSION: 'sess',
  TELEGRAM_SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  WHISPER_URL: 'http://localhost:9000/v1/audio/transcriptions',
  ADMIN_EMAIL: 'a@b.co',
  ADMIN_PASSWORD_HASH: 'scrypt$aa$bb',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('accepts a valid env and applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.RADIO_RECENT_TRACK_WINDOW).toBe(10);
    expect(c.TELEGRAM_API_ID).toBe(123);
  });
  it('fails fast listing every missing var', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      expect(String(e)).toContain('DATABASE_URL');
      expect(String(e)).toContain('JWT_SECRET');
    }
  });
  it('rejects weak JWT secret and malformed password hash', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...valid, ADMIN_PASSWORD_HASH: 'plaintext' })).toThrow(/ADMIN_PASSWORD_HASH/);
  });
  it('redacts secrets', () => {
    const r = redactConfig(loadConfig(valid));
    expect(JSON.stringify(r)).not.toContain('sess');
    expect(JSON.stringify(r)).not.toContain('abab');
    expect(JSON.stringify(r)).not.toContain('hash"');
    expect(r.JWT_SECRET).toBe('[REDACTED]');
  });

  it('treats missing or empty Whisper env as "disabled", not as an error', () => {
    const { WHISPER_URL: _omit, ...withoutWhisper } = valid;
    void _omit;
    expect(isWhisperEnabled(loadConfig(withoutWhisper))).toBe(false);
    expect(isWhisperEnabled(loadConfig({ ...valid, WHISPER_URL: '', WHISPER_API_KEY: '', WHISPER_MODEL: '' }))).toBe(false);
    expect(isWhisperEnabled(loadConfig(valid))).toBe(true);
  });

  it('tolerates CRLF, spaces and quotes from Windows .env files', () => {
    const c = loadConfig({ ...valid, LOG_LEVEL: ' "info"\r', ADMIN_EMAIL: ' a@b.co \r', ADMIN_PASSWORD_HASH: 'scrypt:aa:bb\r' });
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.ADMIN_EMAIL).toBe('a@b.co');
    expect(c.ADMIN_PASSWORD_HASH).toBe('scrypt:aa:bb');
  });
  it('explains a malformed hash without leaking it', () => {
    try {
      loadConfig({ ...valid, ADMIN_PASSWORD_HASH: '> @radio_rainy/api@0.1.0 hash-password scrypt:aa:bb' });
      throw new Error('should have failed');
    } catch (e) {
      expect(String(e)).toContain('ADMIN_PASSWORD_HASH');
      expect(String(e)).toMatch(/starts with "> @radi/);
      expect(String(e)).not.toContain('scrypt:aa:bb');
    }
  });
});
