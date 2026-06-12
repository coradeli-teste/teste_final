import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  RequestWithTraceId,
  TRACE_ID_HEADER,
} from '../middleware/trace-id.middleware';

export interface ErrorPayload {
  statusCode: number;
  message: string | string[];
  error?: string;
}

export interface ErrorEnvelope {
  success: false;
  error: ErrorPayload;
  traceId: string | null;
  timestamp: string;
}

const INTERNAL_ERROR_MESSAGE = 'Internal server error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const request = httpContext.getRequest<RequestWithTraceId>();
    const response = httpContext.getResponse<Response>();

    const traceId = this.resolveTraceId(request, response);
    const { status, error } = this.resolveError(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${traceId ?? 'no-trace'}] Unhandled error`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const envelope: ErrorEnvelope = {
      success: false,
      error,
      traceId,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(envelope);
  }

  private resolveTraceId(
    request: RequestWithTraceId | undefined,
    response: Response,
  ): string | null {
    if (request?.traceId) {
      return request.traceId;
    }
    const headerValue = response.getHeader(TRACE_ID_HEADER);
    return typeof headerValue === 'string' ? headerValue : null;
  }

  private resolveError(exception: unknown): {
    status: number;
    error: ErrorPayload;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      return { status, error: this.normalizeHttpResponse(status, response) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: INTERNAL_ERROR_MESSAGE,
      },
    };
  }

  private normalizeHttpResponse(
    status: number,
    response: string | object,
  ): ErrorPayload {
    if (typeof response === 'string') {
      return { statusCode: status, message: response };
    }

    const body = response as Record<string, unknown>;
    const message = body.message as string | string[] | undefined;
    const error = body.error as string | undefined;

    return {
      statusCode: status,
      message: message ?? INTERNAL_ERROR_MESSAGE,
      ...(error ? { error } : {}),
    };
  }
}
