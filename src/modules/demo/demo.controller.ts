import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Errors } from '../../core/errors/app-error';
import { DemoService, type User } from './demo.service';

/**
 * The controller is the boundary where a `Result` becomes an HTTP response. It
 * unwraps the Result and, on `Err`, throws the `AppError` — which converges on
 * the single global exception filter. There is exactly one place errors turn
 * into responses; the controller never hand-crafts an error body.
 */
@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('users/:id')
  getUser(@Param('id') id: string): User {
    const result = this.demo.findUser(id);
    if (!result.ok) throw result.error; // AppError -> filter -> 404
    return result.value;
  }

  @Post('register')
  async register(@Body() body: unknown): Promise<User> {
    const email = readString(body, 'email');
    const password = readString(body, 'password');
    if (email.length === 0) throw Errors.validation('EMAIL_REQUIRED', 'email is required');

    const result = await this.demo.register(email, password);
    if (!result.ok) throw result.error; // AppError -> filter -> 400
    return result.value;
  }
}

function readString(body: unknown, key: string): string {
  if (body != null && typeof body === 'object' && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
