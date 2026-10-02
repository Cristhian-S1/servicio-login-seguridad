export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "servicio-login",
    version: "0.2.0",
    description: "Login simple: registro + login con JWT (SQLite local).",
  },
  servers: [{ url: "http://localhost:3000" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
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
        summary: "Login: devuelve access token",
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
          "200": { description: "{ accessToken }" },
          "401": { description: "Credenciales invalidas" },
        },
      },
    },
  },
} as const;
