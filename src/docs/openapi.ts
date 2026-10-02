export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "servicio-login",
    version: "0.1.0",
    description: "Servicio de autenticacion: registro, JWT, refresh rotativo, MFA TOTP, RBAC.",
  },
  servers: [{ url: "http://localhost:3000" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { code: { type: "string" }, message: { type: "string" } },
            required: ["code", "message"],
          },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Healthcheck",
        responses: { "200": { description: "OK" } },
      },
    },
    "/auth/register": {
      post: {
        summary: "Registro con email + contrasena",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { email: { type: "string" }, password: { type: "string" } },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Creado: { id, email }" },
          "400": { description: "Validacion" },
          "409": { description: "Email en uso" },
        },
      },
    },
    "/auth/login": {
      post: {
        summary: "Login: tokens o ticket MFA",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { email: { type: "string" }, password: { type: "string" } },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: {
          "200": { description: "{ accessToken, refreshToken } o { mfaRequired, mfaTicket }" },
          "401": { description: "Credenciales invalidas" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        summary: "Rota el refresh token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { refresh_token: { type: "string" } },
                required: ["refresh_token"],
              },
            },
          },
        },
        responses: { "200": { description: "Par nuevo" }, "401": { description: "Invalido o reutilizado" } },
      },
    },
    "/auth/logout": {
      post: {
        summary: "Revoca la familia de sesiones",
        security: [{ bearerAuth: [] }],
        responses: { "204": { description: "Sin contenido" }, "401": { description: "No autenticado" } },
      },
    },
    "/auth/mfa/verify": {
      post: {
        summary: "Paso 2 del login con MFA (TOTP o recovery code)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { ticket: { type: "string" }, code: { type: "string" } },
                required: ["ticket", "code"],
              },
            },
          },
        },
        responses: { "200": { description: "Tokens con mfa:true" }, "401": { description: "Codigo invalido" } },
      },
    },
    "/mfa/setup": {
      post: {
        summary: "Genera el secreto TOTP (autenticado)",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "{ secret, otpauthUrl }" }, "401": { description: "No autenticado" } },
      },
    },
    "/mfa/confirm": {
      post: {
        summary: "Activa MFA y devuelve recovery codes (una vez)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
            },
          },
        },
        responses: { "200": { description: "{ recoveryCodes }" }, "401": { description: "Codigo invalido" } },
      },
    },
    "/users/me": {
      get: {
        summary: "Perfil propio",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "{ id, email, role, mfa_enabled }" } },
      },
    },
    "/admin/users": {
      get: {
        summary: "Lista usuarios (admin + MFA)",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Lista de perfiles" }, "403": { description: "Sin rol o sin MFA" } },
      },
    },
  },
} as const;
