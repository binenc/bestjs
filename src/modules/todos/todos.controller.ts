import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { TodosService, type Todo } from './todos.service';

/**
 * The controller unwraps each `Result`: on `Err` it throws the `AppError`, which
 * the single global filter turns into a typed HTTP envelope. You write happy-path
 * code; validation/not-found become correct status codes for free.
 */
@Controller('todos')
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Get()
  list(): Todo[] {
    return this.todos.list();
  }

  @Post()
  create(@Body() body: unknown): Todo {
    const title = readString(body, 'title');
    const result = this.todos.create(title);
    if (!result.ok) throw result.error; // -> 400 EMPTY_TITLE via the filter
    return result.value;
  }

  @Post(':id/complete')
  complete(@Param('id') id: string): Todo {
    const result = this.todos.complete(id);
    if (!result.ok) throw result.error; // -> 404 TODO_NOT_FOUND via the filter
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
