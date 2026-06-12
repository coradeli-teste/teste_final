import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export const TRACE_ID_HEADER = 'X-Trace-Id';

export interface RequestWithTraceId extends Request {
  traceId: string;
}

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = uuidv4();
    (req as RequestWithTraceId).traceId = traceId;
    res.setHeader(TRACE_ID_HEADER, traceId);
    next();
  }
}
