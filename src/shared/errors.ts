export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Datos invalidos", details?: unknown) {
    super(400, "validation_error", message, details);
  }
}

export class AuthError extends AppError {
  constructor(message = "Credenciales invalidas") {
    super(401, "invalid_credentials", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = "forbidden", message = "Acceso denegado") {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "No encontrado") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(code = "conflict", message = "Conflicto") {
    super(409, code, message);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, "rate_limited", "Demasiados intentos, prueba mas tarde");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class InternalError extends AppError {
  constructor() {
    super(500, "internal_error", "Error interno");
  }
}
