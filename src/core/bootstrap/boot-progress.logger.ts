import { ConsoleLogger } from '@nestjs/common';

/**
 * Behaves exactly like Nest's ConsoleLogger but remembers the last thing Nest
 * did during construction. When the bootstrap watchdog fires, this is how we
 * know WHICH provider/module the startup was wedged on — turning "hung forever"
 * into "hung here".
 */
export class BootProgressLogger extends ConsoleLogger {
  private lastMessage = 'process start';
  private lastAt = Date.now();

  get lastActivity(): string {
    return `${this.lastMessage} (${String(Date.now() - this.lastAt)}ms ago)`;
  }

  override log(message: unknown, ...rest: unknown[]): void {
    const tail = rest.at(-1);
    const ctx = typeof tail === 'string' ? ` @ ${tail}` : '';
    this.lastMessage = `${String(message)}${ctx}`;
    this.lastAt = Date.now();
    super.log(message as string, ...(rest as string[]));
  }
}
