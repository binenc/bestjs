import { Global, Module } from '@nestjs/common';
import { CONFIG, config } from './env.schema';

/**
 * Global config module. Provides the already-validated, frozen `config` under
 * the `CONFIG` token via `useValue` — the same singleton the rest of the process
 * imported at boot, not a second parse. Because validation happened at import
 * time (see env.schema.ts), an invalid environment has already aborted the
 * process long before this module is constructed.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useValue: config }],
  exports: [CONFIG],
})
export class ConfigModule {}

export { CONFIG, config } from './env.schema';
export type { AppConfig } from './env.schema';
