import argon2 from "argon2";

function params() {
  return {
    memoryCost: Number(process.env.ARGON_MEMORY_KIB ?? 19456),
    timeCost: Number(process.env.ARGON_TIME ?? 2),
    parallelism: Number(process.env.ARGON_PARALLELISM ?? 1),
  };
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, ...params() });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
