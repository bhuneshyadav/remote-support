import "dotenv/config";
import { z } from "zod";

const parseBooleanFlag = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase();
  return value ?? "false";
}, z.enum(["true", "false"]).transform((value) => value === "true"));

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.string().url(),
  SESSION_CODE_HMAC_KEY: z.string().min(32),
  SESSION_PENDING_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  SESSION_MAX_MINUTES: z.coerce.number().int().min(1).max(240).default(60),
  TURN_URLS: z.string().optional(),
  TURN_SHARED_SECRET: z.string().min(32).optional(),
  WEB_ORIGIN: z.string().url(),
  ALLOW_LOCAL_DEV_BYPASS: parseBooleanFlag.default(true),
}).superRefine((values, context) => {
  if (Boolean(values.TURN_URLS) !== Boolean(values.TURN_SHARED_SECRET)) {
    context.addIssue({
      code: "custom",
      message: "TURN_URLS and TURN_SHARED_SECRET must be configured together.",
      path: ["TURN_URLS"],
    });
  }
  if (values.TURN_URLS) {
    const urls = values.TURN_URLS.split(",").map((url) => url.trim());
    if (
      urls.length > 8
      || urls.some((url) => !/^turns?:.{1,512}$/i.test(url))
    ) {
      context.addIssue({
        code: "custom",
        message: "TURN_URLS must be a comma-separated list of up to eight TURN URLs.",
        path: ["TURN_URLS"],
      });
    }
  }
});

export const config = configSchema.parse(process.env);
