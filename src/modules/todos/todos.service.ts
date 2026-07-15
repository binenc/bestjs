import { Injectable } from '@nestjs/common';
import { type AppError, Errors } from '../../core/errors/app-error';
import { type Result, err, ok } from '../../core/result';

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

/**
 * A normal feature service — but written in the bestjs idiom: expected failures
 * are returned as `Result<T, AppError>` values, never thrown. Swap the in-memory
 * Map for a real repository and nothing else about the shape changes.
 */
@Injectable()
export class TodosService {
  private readonly todos = new Map<string, Todo>();
  private seq = 0;

  list(): Todo[] {
    return [...this.todos.values()];
  }

  create(title: string): Result<Todo, AppError> {
    if (title.trim().length === 0) {
      return err(Errors.validation('EMPTY_TITLE', 'title must not be empty'));
    }
    const todo: Todo = { id: String(++this.seq), title, done: false };
    this.todos.set(todo.id, todo);
    return ok(todo);
  }

  complete(id: string): Result<Todo, AppError> {
    const todo = this.todos.get(id);
    if (!todo) return err(Errors.notFound('TODO_NOT_FOUND', `no todo with id ${id}`));
    const updated: Todo = { ...todo, done: true };
    this.todos.set(id, updated);
    return ok(updated);
  }
}
