import { Global, Module } from '@nestjs/common';
import { LifecycleState } from './lifecycle-state.service';
import { Managed } from './managed';
import { ResourceRegistry } from './resource-registry';

/**
 * Global so ResourceRegistry / Managed / LifecycleState are injectable app-wide
 * without every feature module importing this one.
 */
@Global()
@Module({
  providers: [ResourceRegistry, LifecycleState, Managed],
  exports: [ResourceRegistry, LifecycleState, Managed],
})
export class LifecycleModule {}
