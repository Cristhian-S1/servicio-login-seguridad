import { z } from "zod";

const CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];

export const emailSchema = z.string().trim().toLowerCase().email("Email invalido").max(320);

export const passwordSchema = z
  .string()
  .min(12, "La contrasena debe tener al menos 12 caracteres")
  .max(256)
  .refine((v) => CLASSES.filter((re) => re.test(v)).length >= 3, "Usa al menos 3 clases: minusculas, mayusculas, digitos, simbolos");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
