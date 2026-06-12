import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  traceId: string | null;
  timestamp: string;
}

@Injectable()
export class ResponseTransformInterceptor<T>
  implements NestInterceptor<T, SuccessEnvelope<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T>> {
    const request = context.switchToHttp().getRequest<{ traceId?: string }>();
    const traceId = request?.traceId ?? null;

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        traceId,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
