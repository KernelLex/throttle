/**
 * Centralised error handling.
 *
 * THE INFORMATION-DISCLOSURE BOUNDARY
 * -----------------------------------
 * This is the single place where an internal error becomes an HTTP response, and it
 * is where the leak would happen if it happened anywhere.
 *
 * Known `AppError`s carry a message written for a user, so they are returned as-is.
 * EVERYTHING ELSE is replaced with a generic message plus a request id. A raw
 * exception can contain a connection string, a SQL fragment, a file path or an
 * upstream provider's verbatim response — none of which a client should ever see.
 *
 * The request id is the bridge: the user can quote it in a support ticket and it
 * correlates exactly with the full, unredacted server log.
 */

import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import type { ApiError, ApiResponse } from '@throttle/core';
import { isProduction } from '../config.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Translate Prisma's error codes into user-facing responses. */
function fromPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002':
      return new AppError(409, 'CONFLICT', 'That record already exists.', {
        context: { target: err.meta?.['target'] },
      });
    case 'P2025':
      return new AppError(404, 'NOT_FOUND', 'Not found.');
    case 'P2003':
      return new AppError(400, 'VALIDATION_ERROR', 'A referenced record does not exist.');
    default:
      return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our end.', {
        cause: err,
      });
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the 4-arg signature to recognise this as an error handler, and
  // delegating after headers are sent is the documented correct behaviour.
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = req.requestId ?? 'unknown';

  let appError: AppError;
  if (isAppError(err)) {
    appError = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appError = fromPrismaError(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    appError = new AppError(400, 'VALIDATION_ERROR', 'Invalid request data.', { cause: err });
  } else {
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our end.', {
      cause: err,
    });
  }

  const logPayload = {
    requestId,
    method: req.method,
    path: req.path,
    statusCode: appError.statusCode,
    code: appError.code,
    context: appError.context,
    err: appError.cause ?? appError,
  };

  // 5xx is our bug; 4xx is the client's. Logging 4xx at error level makes real
  // incidents impossible to find amongst a wall of validation failures.
  if (appError.statusCode >= 500) {
    logger.error(logPayload, appError.message);
  } else {
    logger.info(logPayload, appError.message);
  }

  // `debug` is declared here rather than cast in later, so the extra field is part
  // of the type and cannot silently diverge from what is actually serialised.
  const error: ApiError & { debug?: string } = {
    code: appError.code,
    message: appError.message,
    ...(appError.fields ? { fields: appError.fields } : {}),
    requestId,
  };

  // Outside production, attach the real error to save a trip to the logs. Gated on
  // NODE_ENV so it can never reach a real user.
  if (!isProduction && appError.statusCode >= 500) {
    error.debug =
      appError.cause instanceof Error ? appError.cause.message : String(appError.cause);
  }

  const body: ApiResponse<never> = { ok: false, error };

  res.status(appError.statusCode).json(body);
}

/** Terminal 404 for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiResponse<never> = {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
      requestId: req.requestId ?? 'unknown',
    },
  };
  res.status(404).json(body);
}
