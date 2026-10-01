export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
}

/** The Super Admin accounts. Passwords are stored as scrypt hashes only. */
export interface AdminUserStore {
  findByUsername(username: string): Promise<AdminUser | null>;
  get(id: string): Promise<AdminUser | null>;
  count(): Promise<number>;
  create(username: string, passwordHash: string, mustChangePassword: boolean): Promise<AdminUser>;
  setPassword(id: string, passwordHash: string, mustChangePassword: boolean): Promise<void>;
}

export abstract class AdminUsersRepository {
  abstract findByUsername(username: string): Promise<AdminUser | null>;
  abstract get(id: string): Promise<AdminUser | null>;
  abstract count(): Promise<number>;
  abstract create(username: string, passwordHash: string, mustChangePassword: boolean): Promise<AdminUser>;
  abstract setPassword(id: string, passwordHash: string, mustChangePassword: boolean): Promise<void>;
}
