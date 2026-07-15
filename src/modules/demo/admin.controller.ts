import { Controller, Get } from '@nestjs/common';

/**
 * A route under the `/admin` prefix, protected globally by PathPrefixAuthGuard.
 * Try to reach it via an alternate encoding (`/%61dmin/secret`) or a HEAD
 * request — the canonicalization middleware + HEAD-folding guard collapse every
 * variant to the same protected decision, so none of them bypass auth.
 */
@Controller('admin')
export class AdminController {
  @Get('secret')
  secret(): { ok: true; data: string } {
    return { ok: true, data: 'top secret' };
  }
}
