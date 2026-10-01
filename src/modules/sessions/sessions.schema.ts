import { z } from "zod";

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, "Refresh token requerido").max(512),
});

export type RefreshInput = z.infer<typeof refreshSchema>;
