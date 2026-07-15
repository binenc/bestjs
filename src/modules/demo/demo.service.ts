import { Injectable } from '@nestjs/common';
import { Errors } from '../../core/errors/app-error';
import { type Result, err, ok } from '../../core/result';
import { PasswordService } from '../../core/security/password.service';

export interface User {
  readonly id: string;
  readonly email: string;
}

/**
 * Demonstrates the errors-as-values discipline: domain methods return
 * `Result<T, AppError>`, so the failure branch is in the type signature and the
 * caller cannot reach the value without acknowledging it. Nothing here throws
 * for an expected failure (not-found, weak password) — those are values.
 */
@Injectable()
export class DemoService {
  private readonly users = new Map<string, User>([['1', { id: '1', email: 'ada@example.com' }]]);

  constructor(private readonly passwords: PasswordService) {}

  findUser(id: string): Result<User, ReturnType<typeof Errors.notFound>> {
    const user = this.users.get(id);
    return user ? ok(user) : err(Errors.notFound('USER_NOT_FOUND', `no user with id ${id}`));
  }

  async register(email: string, password: string): Promise<Result<User, ReturnType<typeof Errors.validation>>> {
    if (password.length < 8) {
      return err(Errors.validation('WEAK_PASSWORD', 'password must be at least 8 characters'));
    }
    // Hash with Bun.password (argon2id) — no native addon in sight.
    await this.passwords.hash(password);
    const user: User = { id: String(this.users.size + 1), email };
    this.users.set(user.id, user);
    return ok(user);
  }
}
