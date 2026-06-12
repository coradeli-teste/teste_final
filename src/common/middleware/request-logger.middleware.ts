import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RequestWithTraceId } from './trace-id.middleware';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggerMiddleware.name);

  use(req: Request, _res: Response, next: NextFunction): void {
    const traceId = (req as RequestWithTraceId).traceId;
    const method = req.method;
    const path = req.originalUrl ?? req.url;
    this.logger.log(`[${traceId}] ${method} ${path}`);
    next();
  }
}
