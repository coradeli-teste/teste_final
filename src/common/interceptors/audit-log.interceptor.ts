import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DatabaseService } from '../../database/database.service';

/**
 * Maps route prefixes to the entity (table) they represent.
 */
const ROUTE_ENTITY_MAP: Record<string, string> = {
  '/auth/register': 'users',
  '/auth/login': 'users',
  '/events': 'events',
  '/reservations': 'reservations',
};

/**
 * HTTP methods considered as mutations worth auditing.
 */
const AUDITABLE_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

/**
 * Resolves the entity name from the request path.
 */
function resolveEntity(path: string): string {
  for (const [prefix, entity] of Object.entries(ROUTE_ENTITY_MAP)) {
    if (path.startsWith(prefix)) {
      return entity;
    }
  }
  return 'unknown';
}

/**
 * Determines the action label from HTTP method + path.
 */
function resolveAction(method: string, path: string): string {
  if (path.startsWith('/auth/register')) return 'register';
  if (path.startsWith('/auth/login')) return 'login';

  switch (method) {
    case 'POST':
      return 'create';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'cancel';
    default:
      return method.toLowerCase();
  }
}

/**
 * Extracts the entity ID from the response body or route params.
 * Looks for common patterns: { id }, { reservationId }, or the :id param.
 */
function resolveEntityId(
  responseBody: unknown,
  routeParams: Record<string, string>,
): string | null {
  if (responseBody && typeof responseBody === 'object') {
    const body = responseBody as Record<string, unknown>;
    if (typeof body.id === 'string') return body.id;
    if (typeof body.reservationId === 'string') return body.reservationId;
  }
  if (routeParams?.id) return routeParams.id;
  return null;
}

/**
 * Centralized audit log interceptor.
 * Captures mutations (POST, PATCH, DELETE) and writes a row to the
 * `audit_logs` table with: traceId, userId, action, entity, entityId.
 *
 * Runs AFTER the handler completes successfully (inside `tap`), so failed
 * requests (exceptions) are NOT logged — only successful state changes.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private readonly database: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url?: string;
      traceId?: string;
      user?: { id: string };
      params?: Record<string, string>;
    }>();

    const method = request.method;

    if (!AUDITABLE_METHODS.has(method)) {
      return next.handle();
    }

    const path = request.originalUrl ?? request.url ?? '';
    const traceId = request.traceId ?? 'no-trace';
    const userId = request.user?.id ?? null;
    const entity = resolveEntity(path);
    const action = resolveAction(method, path);

    return next.handle().pipe(
      tap((responseBody) => {
        const entityId = resolveEntityId(responseBody, request.params ?? {});
        const now = new Date().toISOString();

        try {
          this.database.run(
            `INSERT INTO audit_logs (trace_id, user_id, action, entity, entity_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [traceId, userId, action, entity, entityId, now],
          );
        } catch (error) {
          // Audit log failure must never break the main operation
          this.logger.warn(
            `Failed to write audit log: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
}
