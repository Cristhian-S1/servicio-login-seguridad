import { z } from "zod";

export const mfaCodeSchema = z.object({
  code: z.string().trim().min(6, "Codigo requerido").max(32),
});

export type MfaCodeInput = z.infer<typeof mfaCodeSchema>;

export const mfaVerifySchema = z.object({
  ticket: z.string().min(1, "Ticket requerido"),
  code: z.string().trim().min(6, "Codigo requerido").max(32),
});

export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;
