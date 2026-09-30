import { ConfigError, loadConfig, redactConfig } from './app-config';

const valid = {
  TELEGRAM_API_ID: '123',
  TELEGRAM_API_HASH: 'hash',
  TELEGRAM_SESSION: 'sess',
  TELEGRAM_SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
  TELEGRAM_CHANNEL: '@chan',
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
      expect(String(e)).toContain('TELEGRAM_API_HASH');
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
});
