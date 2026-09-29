/**
 * Request validation and async handler wrapping.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { badRequest } from '../lib/errors.js';

/**
 * Wrap an async handler so a rejected promise reaches Express's error handler.
 *
 * Express 4 does NOT catch rejections from async handlers: an unhandled one hangs the
 * request until timeout and crashes the process on `unhandledRejection`. Every async
 * route in this codebase goes through here.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Flatten a ZodError into `{ "field.path": ["message"] }`. */
function toFieldErrors(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    (fields[path] ??= []).push(issue.message);
  }

  return fields;
}

/**
 * Validate and REPLACE `req.body` with the parsed result.
 *
 * Replacing matters: Zod strips unknown keys, so downstream handlers cannot
 * accidentally read an attacker-supplied field that was never part of the schema —
 * mass-assignment prevention by construction rather than by discipline.
 */
export function validateBody<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(badRequest('Please check the highlighted fields.', toFieldErrors(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(badRequest('Invalid query parameters.', toFieldErrors(result.error)));
      return;
    }
    // req.query is a getter-only property in Express 5 and read-only in some setups,
    // so the parsed value is stashed separately rather than assigned back.
    (req as Request & { validatedQuery?: unknown }).validatedQuery = result.data;
    next();
  };
}

/** Read the result of `validateQuery`. */
export function getQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery as T;
}
